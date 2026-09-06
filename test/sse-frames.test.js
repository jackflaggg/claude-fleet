import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseFrameParser } from '../src/http/sse-frames.js';

test('кадр, разрезанный по границе чанков, собирается целиком', () => {
  const parser = createSseFrameParser();
  assert.deepEqual(parser.push('data: {"type":"mes'), []);
  assert.deepEqual(parser.push('sage","text":"hi"}\n\n'), ['{"type":"message","text":"hi"}']);
});

test('два кадра в одном чанке дают два payload, хвост ждёт продолжения', () => {
  const parser = createSseFrameParser();
  assert.deepEqual(parser.push('data: a\n\ndata: b\n\ndata: c'), ['a', 'b']);
  assert.deepEqual(parser.push('\n\n'), ['c']);
});

test('комментарии и пустые кадры пропускаются, многострочный data склеивается переводом строки', () => {
  const parser = createSseFrameParser();
  assert.deepEqual(parser.push(': fleet channel\n\n: ping\n\n'), []);
  assert.deepEqual(parser.push('data: первая\ndata: вторая\n\n'), ['первая\nвторая']);
  assert.deepEqual(parser.push('event: x\nid: 7\n\n'), []);
});

test('кадр без разделителя длиннее потолка сбрасывается, поток живёт дальше', () => {
  const parser = createSseFrameParser({ maxBuffer: 16 });
  assert.deepEqual(parser.push('data: ' + 'x'.repeat(20)), []);
  assert.deepEqual(parser.push('\n\ndata: ok\n\n'), ['ok']);
});
