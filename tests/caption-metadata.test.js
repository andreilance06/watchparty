const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProbe } = require('../server/media/probe');
const { createSubtitleService } = require('../server/media/subtitles');

test('subtitle names and dispositions come from their own stream metadata', () => {
  const output = { format: { duration: '12', tags: { title: 'Container title' } }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', tags: { title: 'Video title' } },
    { index: 1, codec_type: 'subtitle', codec_name: 'ass', tags: { title: 'Signs & Songs 日本語', language: 'jpn', handler_name: 'Less specific name' }, disposition: { default: 1, forced: 1 } },
    { index: 2, id: '0x3', codec_type: 'subtitle', codec_name: 'subrip', tags: { handler_name: 'English dialogue', language: 'eng' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'webvtt', tags: { encoder: 'Lavc' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { title: 'Bitmap track', language: 'fra' } },
    { index: 5, codec_type: 'audio', codec_name: 'aac', tags: { title: 'Audio title' } },
    { index: 6, codec_type: 'subtitle', codec_name: 'mov_text', tags: { title: 'Commentary', language: 'eng' } }
  ] };
  const tracks = parseProbe(output, 'movie.mkv', '/movie.mkv').subtitles;
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
  const state = { sessionId: 'session-test', hlsDirectory: '/tmp/captions', basePath: '/rooms/test' };
  const service = createSubtitleService({ state, config: {} });
  service.setFonts([{ extension: 'ttf' }], 4);
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
  assert.equal(external.url, '/rooms/test/hls/captions_1.ass?s=session-test&v=4');
  assert.deepEqual(external.fonts, ['/rooms/test/hls/font_0.ttf?s=session-test&v=4']);
});
