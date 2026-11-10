'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMedia } = require('../lib/parse');

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

test('movies', () => {
  const cases = [
    ['/m/Big Sun (2021)/Big Sun (2021).mkv', 'Big Sun', 2021],
    ['/m/Night.Drive.2019.1080p.BluRay.x265-GRP.mkv', 'Night Drive', 2019],
    ['/m/Blade Runner 2049 (2017).mp4', 'Blade Runner 2049', 2017],
    ['/m/2001 A Space Odyssey (1968).mkv', '2001 A Space Odyssey', 1968],
    ['/m/[grp] Some_Movie_720p.mkv', 'Some Movie', null],
    ['/m/Old Tape (1994)/tape.mp4', 'tape', 1994],
    ['/m/Mr. Nobody (2009).mkv', 'Mr. Nobody', 2009],
  ];
  for (const [file, title, year] of cases) {
    assert.deepEqual(pick(parseMedia(file), ['type', 'title', 'year']), { type: 'movie', title, year }, file);
  }
});

test('episodes', () => {
  const keys = ['type', 'show', 'season', 'episode', 'title'];
  const ep = (show, season, episode, title) => ({ type: 'episode', show, season, episode, title });
  const cases = [
    ['/tv/Solar Winds/Season 1/Solar Winds S01E02 - Dawn.mkv', ep('Solar Winds', 1, 2, 'Dawn')],
    ['/tv/Solar.Winds.S02E10.The.End.1080p.WEB-DL.mkv', ep('Solar Winds', 2, 10, 'The End')],
    ['/tv/Solar Winds (2020)/Season 1/S01E03.mkv', ep('Solar Winds', 1, 3, 'Episode 3')],
    ['/tv/Solar Winds/Season 2/04 - Dusk.mkv', ep('Solar Winds', 2, 4, 'Dusk')],
    ['/tv/Solar Winds/solar winds 3x07.mp4', ep('solar winds', 3, 7, 'Episode 7')],
    ['/tv/Solar Winds/Specials/S00E01 - Making Of.mkv', ep('Solar Winds', 0, 1, 'Making Of')],
    ['/tv/Show/Show S01E01E02 - Pilot.mkv', ep('Show', 1, 1, 'Pilot')],
  ];
  for (const [file, want] of cases) assert.deepEqual(pick(parseMedia(file), keys), want, file);
});

test('same show gets the same key however the file is named', () => {
  const a = parseMedia('/tv/Solar Winds/Season 1/Solar Winds S01E02.mkv');
  const b = parseMedia('/tv/Solar.Winds.S02E10.1080p.mkv');
  assert.equal(a.showKey, b.showKey);
});

test('a resolution is not an episode number', () => {
  assert.equal(parseMedia('/m/Clip 1920x1080.mp4').type, 'movie');
});

test('a TMDB id in the name pins the match and stays out of the title', () => {
  const m = parseMedia('/m/Big Sun (2021) {tmdb-603}/Big Sun (2021) {tmdb-603}.mkv');
  assert.deepEqual([m.title, m.year, m.tmdbId], ['Big Sun', 2021, 603]);
  assert.equal(parseMedia('/m/Big Sun (2021) [tmdbid-42].mkv').tmdbId, 42);
  const e = parseMedia('/tv/Solar Winds {tmdb-77}/Season 1/Solar Winds S01E02.mkv');
  assert.deepEqual([e.show, e.tmdbId], ['Solar Winds', 77]);
  assert.equal(parseMedia('/m/Big Sun (2021).mkv').tmdbId, null);
});
