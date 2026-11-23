# DJI Mic → TinyCloud

Run this script after recording. It copies finished WAVs from a mounted DJI transmitter, transcribes them locally, and stores the original WAV and transcript in **your** TinyCloud `applications` space. It also leaves a short excerpt and a ready-to-paste agent prompt beside each recording. It does not modify the transmitter.

## Set up once

1. Install Python 3.10+, FFmpeg, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli` on `PATH`), and the [TinyCloud CLI](https://agents.tinycloud.xyz/connect) (`tinycloud`, verified with `@tinycloud/cli` 1.8.0). On macOS, `brew install ffmpeg whisper.cpp` installs the audio tools. On Linux, install FFmpeg with your package manager and follow the whisper.cpp build instructions. Download [the `base.en` model](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-base.en.bin) for English, or use a multilingual model and add `--language auto` (or the language code) to the import command. Transcription runs on your computer and needs no API key.
2. Use the OpenKey owner that already has your TinyCloud `applications` space. Copy its `ownerDid` from `tinycloud --profile YOUR_EXISTING_PROFILE context --json`; if you haven't set up TinyCloud, use the linked setup guide first. Run these commands from this example directory. Use an unused name in place of `dji-mic` if needed, and use that name consistently:

   ```sh
   OWNER_DID='did:pkh:eip155:1:0xYOUR_ADDRESS'
   tinycloud init --name dji-mic --key-only
   tinycloud --profile dji-mic auth login --method openkey \
     --owner "$OWNER_DID" --manifest ./manifest.json --expiry 7d
   ```

   Approve the request with that owner in OpenKey. It requests read, metadata, and write for the recordings folder, plus the capability read required to sign in. The script checks the owner and space before copying or uploading. Use the same login command if the grant expires.

## Import a recording

Stop recording, then connect the **transmitter** (not the receiver) with a USB-C data cable. The transmitter needs onboard recording and USB file transfer; see the [DJI Mic 2 support guide](https://www.dji.com/support/product/mic-2). Make sure you have consent to record. This workflow uses the mounted drive, not Bluetooth.

```sh
python3 dji_mic.py --profile dji-mic --owner "$OWNER_DID" \
  --model "$HOME/models/ggml-base.en.bin" --output "$HOME/DJI recordings"
```

Use the path where you saved the model. The script looks for a mounted volume named `DJI_MIC` or a DJI Mic model variant on macOS or Linux (`findmnt` on Linux). If it cannot identify the mount or two transmitters are connected, add `--source '/Volumes/DJI_MIC'` (substitute the actual mount). To try it without a mic, add `--source /path/to/test-wavs` containing a short, consented or synthetic WAV. That tests the file workflow, not the physical USB connection. If `tinycloud` is not on `PATH`, use `--tc /path/to/your/tinycloud` (or the TinyCloud `tc` alias).

The run prints the recording ID and local prompt path for each recording. Under the output directory, `<sha256>/` contains:

| File | Contents | Stored in TinyCloud |
| --- | --- | --- |
| `audio.wav` | Original recording, byte for byte | Yes |
| `transcript.txt` | UTF-8 text from whisper.cpp | Yes |
| `gist.txt` | Up to the first two transcript sentences, capped at 60 words | No |
| `prompt.txt` | Read-only prompt for an agent to summarize that specific transcript | No |

Remote keys are `xyz.tinycloud.dji-mic/recordings/<sha256>/audio.wav` and `xyz.tinycloud.dji-mic/recordings/<sha256>/transcript.txt` in the same owner's `applications` space. They are regular KV payloads. No Share links are created. The audio and text count toward your TinyCloud storage quota.

Paste the contents of `prompt.txt` into your agent when you want notes. The agent needs its own authorized read access to that transcript. To read it directly from the import profile:

```sh
RECORDING_ID='sha256-printed-by-the-script'
SPACE="tinycloud:${OWNER_DID#did:}:applications"
tinycloud --profile dji-mic kv get \
  "xyz.tinycloud.dji-mic/recordings/$RECORDING_ID/transcript.txt" --space "$SPACE" --raw
```

Rerun the same import command for new recordings. Identical WAV contents reuse the same ID even after renaming. Existing TinyCloud keys are not overwritten; if an upload was interrupted, rerun to complete missing keys. Keep a private output directory, and eject the drive normally when finished.

For a disposable test, discard the temporary output directory after verifying the two remote keys. To remove test uploads on a hosted account, delete those exact keys using the owner's deletion authority; the import profile cannot delete. Revoke the dedicated login in [TinyCloud account settings](https://account.tinycloud.xyz/delegations) and remove that test profile. Revoking the login does not delete stored recordings.

## Tests

```sh
python3 -B -m unittest -v
```

The unit tests use temporary files and mount-table inputs and do not need a mic, model, or TinyCloud credentials.
