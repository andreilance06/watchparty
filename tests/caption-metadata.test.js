const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSubtitleStreams } = require('../server/media/probe');
const { createSubtitleService } = require('../server/media/subtitles');

test('subtitle names and dispositions come from their own stream metadata', () => {
  const output = `Input #0, matroska,webm, from 'movie.mkv':
  Metadata:
    title           : Container title
  Duration: 00:00:12.00, start: 0.000000
  Stream #0:0: Video: h264, yuv420p, 640x360
    Metadata:
      title           : Video title
  Stream #0:1(jpn): Subtitle: ass (default) (forced)
    Metadata:
      title           : Signs & Songs 日本語
      handler_name    : Less specific name
  Stream #0:2[0x3](eng): Subtitle: subrip
    Metadata:
      HANDLER_NAME    : English dialogue
  Stream #0:3: Subtitle: webvtt
    Metadata:
      encoder         : Lavc
  Stream #0:4(fra): Subtitle: hdmv_pgs_subtitle (default)
    Metadata:
      title           : Bitmap track
  Stream #0:5(eng): Audio: aac, 48000 Hz, stereo
    Metadata:
      title           : Audio title
  Stream #0:6(eng): Subtitle: mov_text
    Metadata:
      title           : Commentary
`;
  const tracks = parseSubtitleStreams(output, '/movie.mkv');
  assert.equal(tracks.length, 4);
  assert.deepEqual(tracks.map(track => [track.map, track.label, track.lang, track.default, track.forced]), [
    ['0:1', 'Signs & Songs 日本語', 'jpn', true, true],
    ['0:2', 'English dialogue', 'eng', false, false],
    ['0:3', 'Captions 3', 'und', false, false],
    ['0:6', 'Commentary', 'eng', false, false]
  ]);
  assert.equal(tracks[0].title, 'Signs & Songs 日本語');
  assert.equal(tracks[2].title, undefined);
  assert.equal(tracks[0].input, '/movie.mkv');
});

test('caption descriptors preserve stream metadata and external filenames without altering language codes', () => {
  const state = { hlsDirectory: '/tmp/captions', basePath: '/rooms/test' };
  const service = createSubtitleService({ state, config: {} });
  const embedded = service.register({ id: 'one', fileName: 'captions_0.ass', title: 'Signs', label: 'Signs',
    lang: 'eng', default: true, forced: true, codec: 'ass' }, 4);
  assert.equal(embedded.title, 'Signs');
  assert.equal(embedded.default, true);
  assert.equal(embedded.forced, true);
  assert.equal(embedded.lang, 'eng');
  const external = service.register({ id: 'two', fileName: 'captions_1.ass', label: 'movie.en.srt', codec: 'srt' }, 4);
  assert.equal(external.label, 'movie.en.srt');
  assert.equal(external.lang, 'und');
  assert.equal(external.default, false);
  assert.equal(external.forced, false);
  assert.equal(external.url, '/rooms/test/hls/captions_1.ass?v=4');
});
