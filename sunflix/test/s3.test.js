'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { S3 } = require('../lib/s3');

// The worked example from Amazon's Signature Version 4 documentation for presigned URLs.
test('presigned URLs match the published AWS example', () => {
  const s3 = new S3({
    endpoint: 'https://examplebucket.s3.amazonaws.com', bucket: '', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });
  const url = s3.presign('GET', 'test.txt', {}, 86400, new Date('2013-05-24T00:00:00Z'));
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('object names with spaces and symbols are encoded per path segment', () => {
  const s3 = new S3({ endpoint: 'https://acct.r2.example', bucket: 'media', accessKeyId: 'a', secretAccessKey: 'b' });
  assert.ok(s3.presign('PUT', 'videos/a b(1).mp4').startsWith('https://acct.r2.example/media/videos/a%20b%281%29.mp4?'));
});

// The "GET Object" worked example from the same documentation, for requests signed in headers.
test('header-signed requests match the published AWS example', () => {
  const s3 = new S3({
    endpoint: 'https://examplebucket.s3.amazonaws.com', bucket: '', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });
  const { headers } = s3.sign('GET', 'test.txt', { headers: { Range: 'bytes=0-9' } }, new Date('2013-05-24T00:00:00Z'));
  assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});
