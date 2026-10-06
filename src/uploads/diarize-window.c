// Speaker diarization of one window of a 16 kHz mono s16le PCM file, for src/uploads/diarize.ts (TC-595).
//
//   diarize-window <segmentation.onnx> <embedding.onnx> <onnxruntime.config> <threshold> <threads> <pcm> <start sample> <samples>
//
// Runs sherpa-onnx offline speaker diarization (pyannote segmentation-3.0 + speaker embeddings + fast clustering)
// over samples [start, start + samples) with the settings of the sherpa-onnx CLI as benchmarked, and prints, times in seconds from the window start:
//   segment <start> <end> <local speaker>
//   speaker <local speaker> <embedded seconds> <embedding values...>
// The embedding of a local speaker is the duration-weighted mean of the L2-normalized embeddings of its clearest
// speech: the parts of its segments where no other speaker is talking, in pieces of 1-10 s, longest first, at most
// 60 s (or at most 10 s of its longest segment when it has no such piece). The caller links local speakers across
// windows with it.
// Only this window's samples are held in memory, and the diarizer is freed before embeddings are computed.
//
// Memory (docs/diarization-benchmark.md): onnxruntime's arena and memory patterns are off (the config file), every
// allocation of 4 MiB or more is its own mapping (returned to the system when freed), and the heap is trimmed once
// 64 MiB at its top are free. With onnxruntime's arena and glibc's defaults (a mmap threshold that grows to 32 MiB), the
// embedding model's per-inference buffers of varying sizes fragment memory and a 10-minute window peaks at 250-380 MB.
// Smaller thresholds save a little more memory at a large cost in page faults (measured in the benchmark).

#include <malloc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

#define RATE 16000
#define PIECE_MIN 1.0f
#define PIECE_MAX 10.0f
#define EMBED_MAX 60.0f

typedef struct { float start, end; } Span;

static int by_length_desc(const void *a, const void *b) {
  float la = ((const Span *)a)->end - ((const Span *)a)->start, lb = ((const Span *)b)->end - ((const Span *)b)->start;
  return (la < lb) - (la > lb);
}

static void *must(void *p) {
  if (!p) { fprintf(stderr, "out of memory\n"); exit(1); }
  return p;
}

int main(int argc, char **argv) {
  mallopt(M_MMAP_THRESHOLD, 4 << 20);
  mallopt(M_TRIM_THRESHOLD, 64 << 20);
  if (argc != 9) {
    fprintf(stderr, "usage: %s <segmentation.onnx> <embedding.onnx> <onnxruntime.config> <threshold> <threads> <pcm> <start sample> <samples>\n", argv[0]);
    return 2;
  }
  const float threshold = strtof(argv[4], NULL);
  const int threads = atoi(argv[5]);
  const long start = atol(argv[7]);
  long count = atol(argv[8]);
  if (!(threshold > 0) || threads < 1 || start < 0 || count < 1) { fprintf(stderr, "bad arguments\n"); return 2; }

  // sherpa-onnx reads onnxruntime session options from the file named after "cpu:" (see the config file).
  char provider[4096];
  if (snprintf(provider, sizeof(provider), "cpu:%s", argv[3]) >= (int)sizeof(provider)) { fprintf(stderr, "bad arguments\n"); return 2; }

  FILE *f = fopen(argv[6], "rb");
  if (!f || fseek(f, start * 2, SEEK_SET) != 0) { fprintf(stderr, "cannot read pcm\n"); return 1; }
  int16_t *pcm = must(malloc(count * sizeof(int16_t)));
  count = (long)fread(pcm, sizeof(int16_t), count, f);
  fclose(f);
  if (count < 1) { fprintf(stderr, "window is past the end of the pcm\n"); return 1; }
  float *samples = must(malloc(count * sizeof(float)));
  for (long i = 0; i < count; i++) samples[i] = pcm[i] / 32768.0f;
  free(pcm);

  SherpaOnnxOfflineSpeakerDiarizationConfig config;
  memset(&config, 0, sizeof(config));
  config.segmentation.pyannote.model = argv[1];
  config.segmentation.num_threads = threads;
  config.segmentation.provider = provider;
  config.embedding.model = argv[2];
  config.embedding.num_threads = threads;
  config.embedding.provider = provider;
  config.clustering.num_clusters = -1;
  config.clustering.threshold = threshold;
  config.min_duration_on = 0.3f; // the sherpa-onnx CLI defaults, as benchmarked
  config.min_duration_off = 0.5f;
  const SherpaOnnxOfflineSpeakerDiarization *sd = SherpaOnnxCreateOfflineSpeakerDiarization(&config);
  if (!sd) { fprintf(stderr, "cannot load the diarization models\n"); return 1; }
  const SherpaOnnxOfflineSpeakerDiarizationResult *result = SherpaOnnxOfflineSpeakerDiarizationProcess(sd, samples, (int32_t)count);
  if (!result) { fprintf(stderr, "diarization failed\n"); return 1; }
  const int n = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result);
  const SherpaOnnxOfflineSpeakerDiarizationSegment *segments = n > 0 ? SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(result) : NULL;
  int speakers = 0;
  for (int i = 0; i < n; i++) {
    printf("segment %.3f %.3f %d\n", segments[i].start, segments[i].end, segments[i].speaker);
    if (segments[i].speaker + 1 > speakers) speakers = segments[i].speaker + 1;
  }
  SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
  SherpaOnnxDestroyOfflineSpeakerDiarization(sd);

  SherpaOnnxSpeakerEmbeddingExtractorConfig ec;
  memset(&ec, 0, sizeof(ec));
  ec.model = argv[2];
  ec.num_threads = threads;
  ec.provider = provider;
  const SherpaOnnxSpeakerEmbeddingExtractor *ex = speakers > 0 ? SherpaOnnxCreateSpeakerEmbeddingExtractor(&ec) : NULL;
  if (speakers > 0 && !ex) { fprintf(stderr, "cannot load the embedding model\n"); return 1; }
  const int dim = ex ? SherpaOnnxSpeakerEmbeddingExtractorDim(ex) : 0;
  double *sum = must(calloc(dim > 0 ? dim : 1, sizeof(double)));
  int cap = 64;
  Span *pieces = must(malloc(cap * sizeof(Span)));
  const float total = (float)count / RATE;

  for (int k = 0; k < speakers; k++) {
    // The parts of speaker k's segments that no other speaker overlaps (segments are sorted by start, so one sweep
    // per segment finds them), cut into pieces of PIECE_MIN to PIECE_MAX seconds.
    int np = 0;
    Span longest = {0, 0};
    for (int i = 0; i < n; i++) {
      if (segments[i].speaker != k) continue;
      const float s = segments[i].start, e = segments[i].end;
      if (e - s > longest.end - longest.start) longest = (Span){s, e};
      float cur = s;
      for (int j = 0; j <= n && cur < e; j++) {
        const int last = j == n;
        if (!last && (segments[j].speaker == k || segments[j].end <= cur || segments[j].start >= e)) continue;
        const float to = last ? e : segments[j].start;
        for (float p = cur; to - p >= PIECE_MIN; p += PIECE_MAX) {
          if (np == cap) pieces = must(realloc(pieces, (cap *= 2) * sizeof(Span)));
          pieces[np++] = (Span){p, p + PIECE_MAX < to ? p + PIECE_MAX : to};
        }
        if (!last && segments[j].end > cur) cur = segments[j].end;
      }
    }
    if (np == 0 && longest.end > longest.start) { // no clear piece: the middle PIECE_MAX of its longest segment
      const float mid = (longest.start + longest.end) / 2;
      pieces[np++] = longest.end - longest.start > PIECE_MAX ? (Span){mid - PIECE_MAX / 2, mid + PIECE_MAX / 2} : longest;
    }
    qsort(pieces, np, sizeof(Span), by_length_desc);

    memset(sum, 0, (dim > 0 ? dim : 1) * sizeof(double));
    double seconds = 0;
    for (int p = 0; p < np && seconds < EMBED_MAX; p++) {
      long a = (long)(pieces[p].start * RATE), b = (long)((pieces[p].end < total ? pieces[p].end : total) * RATE);
      if (b <= a) continue;
      const SherpaOnnxOnlineStream *stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(ex);
      SherpaOnnxOnlineStreamAcceptWaveform(stream, RATE, samples + a, (int32_t)(b - a));
      SherpaOnnxOnlineStreamInputFinished(stream);
      if (SherpaOnnxSpeakerEmbeddingExtractorIsReady(ex, stream)) {
        const float *v = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(ex, stream);
        double norm = 0;
        for (int d = 0; d < dim; d++) norm += (double)v[d] * v[d];
        norm = sqrt(norm);
        if (norm > 0) {
          const double w = (double)(b - a) / RATE;
          for (int d = 0; d < dim; d++) sum[d] += w * v[d] / norm;
          seconds += w;
        }
        SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(v);
      }
      SherpaOnnxDestroyOnlineStream(stream);
    }
    printf("speaker %d %.3f", k, seconds);
    if (seconds > 0) for (int d = 0; d < dim; d++) printf(" %.6g", sum[d] / seconds);
    printf("\n");
  }

  if (ex) SherpaOnnxDestroySpeakerEmbeddingExtractor(ex);
  if (segments) SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segments);
  free(pieces);
  free(sum);
  free(samples);
  return fflush(stdout) == 0 ? 0 : 1;
}
