'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickMatch } = require('../lib/tmdb');

const pick = (results, title, year) => (pickMatch(results, title, year, 'title', 'release_date') || {}).id;

test('exact title and year beats a more popular near miss', () => {
  const results = [
    { id: 1, title: 'Big Sun Rising', release_date: '2021-03-01' },
    { id: 2, title: 'Big Sun', release_date: '1998-01-01' },
    { id: 3, title: 'Big Sun', release_date: '2021-06-01' },
  ];
  assert.equal(pick(results, 'Big Sun', 2021), 3);
});

test('a year that is one off still matches', () => {
  assert.equal(pick([{ id: 9, title: 'Night Drive', release_date: '2020-01-10' }], 'Night Drive', 2019), 9);
});

test('original-language titles and punctuation are tolerated', () => {
  assert.equal(pick([{ id: 5, title: 'The Long Tide', original_title: 'La Longue Marée', release_date: '2022-01-01' }], 'La Longue Maree', 2022), 5);
  assert.equal(pick([{ id: 6, title: 'Mr. Nobody', release_date: '2009-01-01' }], 'Mr Nobody', 2009), 6);
});

test('unrelated results are refused rather than guessed', () => {
  assert.equal(pick([{ id: 7, title: 'Completely Different Film', release_date: '2021-01-01' }], 'Big Sun', 2021), undefined);
  assert.equal(pick([], 'Big Sun', 2021), undefined);
});
