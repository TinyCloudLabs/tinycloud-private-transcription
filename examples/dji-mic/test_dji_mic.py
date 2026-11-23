import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import dji_mic


class ImportTests(unittest.TestCase):
    def test_auto_detects_dji_labels_and_mount_names_only(self):
        mounts = [('/media/USB Backup', 'BACKUP'), ('/media/RECORDER', 'DJI MIC 2'),
                  ('/Volumes/DJI_MIC', None), ('/Volumes/DJI_Microphone backup', None)]
        self.assertEqual(dji_mic.dji_volumes(mounts), [
            Path('/Volumes/DJI_MIC'), Path('/media/RECORDER'),
        ])

    def test_auto_detection_refuses_to_choose_between_two_transmitters(self):
        mounts = [('/media/DJI_MIC', 'DJI_MIC'), ('/media/DJI_MIC1', 'DJI_MIC')]
        with patch.object(dji_mic, 'mounted_volumes', return_value=mounts):
            with self.assertRaisesRegex(ValueError, 'Multiple DJI volumes'):
                dji_mic.recording_source(None)

    def test_only_real_wavs_are_discovered(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / 'nested').mkdir()
            wav = source / 'nested' / 'Second take.WAV'
            wav.touch()
            (source / 'notes.txt').touch()
            (source / '._Second take.WAV').touch()
            (source / 'mic.wav').symlink_to(wav)
            (source / 'linked').symlink_to(source / 'nested', target_is_directory=True)
            self.assertEqual([path for path, _ in dji_mic.wave_files(source)], [wav])

    def test_same_bytes_never_recopy_even_if_renamed_but_reused_name_can_be_new(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            original = root / 'first take.WAV'
            original.write_bytes(b'first recording')
            out = root / 'out'
            first, copied = dji_mic.stage_recording(original, out)
            self.assertTrue(copied)
            self.assertEqual(first, out / hashlib.sha256(b'first recording').hexdigest() / 'audio.wav')
            before = first.stat()

            renamed = original.rename(root / 'same audio.wav')
            again, copied = dji_mic.stage_recording(renamed, out)
            self.assertFalse(copied)
            self.assertEqual(again, first)
            self.assertEqual(again.stat().st_mtime_ns, before.st_mtime_ns)

            original.write_bytes(b'new recording')
            second, copied = dji_mic.stage_recording(original, out)
            self.assertTrue(copied)
            self.assertNotEqual(second, first)
            self.assertEqual(first.read_bytes(), b'first recording')
            self.assertEqual(second.read_bytes(), b'new recording')

    def test_source_with_another_hard_link_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            original = root / 'original.wav'
            original.write_bytes(b'a recording')
            alias = root / 'alias.wav'
            os.link(original, alias)
            with self.assertRaisesRegex(ValueError, 'singly linked regular file'):
                dji_mic.stage_recording(alias, root / 'out')
            self.assertFalse((root / 'out').exists())

    def test_output_directory_must_be_private_and_not_a_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            public = root / 'public'
            public.mkdir()
            public.chmod(0o755)
            private = root / 'private'
            private.mkdir(mode=0o700)
            alias = root / 'alias'
            alias.symlink_to(private, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, '0700'):
                dji_mic.private_directory(public)
            with self.assertRaises(OSError):
                dji_mic.private_directory(alias)

    def test_output_in_a_sibling_directory_on_the_source_mount_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            source = root / 'recordings'
            source.mkdir()
            with self.assertRaisesRegex(ValueError, 'different volume'):
                dji_mic.output_destination(source, root / 'exports' / 'new')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'requires FFmpeg')
    def test_wav_decoder_rejects_an_inert_playlist(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / 'playlist.wav'
            source.write_text('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n', encoding='ascii')
            destination = root / 'transcript.txt'
            result = subprocess.run(
                [sys.executable, '-B', '-c',
                 'import sys; from pathlib import Path; from dji_mic import transcribe; '
                 'transcribe(Path(sys.argv[1]), Path(sys.argv[2]), Path("unused"), "en")',
                 str(source), str(destination)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('invalid start code', result.stderr)
            self.assertFalse(destination.exists())

    def test_refuses_a_profile_for_another_owner_or_space(self):
        expected = 'did:pkh:eip155:1:0x' + '12' * 20
        space = 'tinycloud:pkh:eip155:1:0x' + '12' * 20 + ':applications'
        for context in (
            {'ownerDid': 'did:pkh:eip155:1:0x' + '34' * 20, 'spaceId': space},
            {'ownerDid': expected, 'spaceId': space.replace('applications', 'default')},
        ):
            with self.subTest(context=context), self.assertRaisesRegex(ValueError, 'owner.*applications'):
                dji_mic.verify_context(context, expected, space)


if __name__ == '__main__':
    unittest.main()
