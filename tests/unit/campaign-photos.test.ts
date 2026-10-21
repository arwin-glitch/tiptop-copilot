import { describe, expect, it } from 'vitest';
import { BUCKET_ALLOWED_MIME_TYPES } from '@/lib/storage/allowed-types';
import {
  PHOTO_MIME,
  declaredPhotoKind,
  fileStem,
  isPhotoName,
  isPhotoType,
  matchKey,
  matchPhoto,
  photoKindOfName,
  photoKindOfType,
  photoMatcher,
  sniffPhoto,
  type PhotoCandidate,
} from '@/lib/campaigns/photos';

/**
 * Which recipient a photo belongs to, by its file name. The rule that
 * matters most: a name that fits nobody, or fits two people, is never given
 * to anyone automatically.
 */

const PEOPLE: PhotoCandidate[] = [
  { id: 'r-jane', email: 'jane@acme.example', name: 'Jane Doe' },
  { id: 'r-sam', email: 'sam.lee@lee-family.example', name: 'Sam Lee' },
  { id: 'r-ana', email: 'ana@orchard.example', name: null, merge: { name: 'Ana Núñez' } },
  { id: 'r-wei', email: 'wei.chen@harbor.example', name: 'Wei Chen' },
];

describe('matchKey and fileStem', () => {
  it('lowercases and drops spaces, underscores, dashes, dots and other punctuation', () => {
    for (const v of ['Jane Doe', 'jane_doe', 'JANE-DOE', 'Jane.Doe', "jane  'doe'"]) {
      expect(matchKey(v)).toBe('janedoe');
    }
    expect(matchKey('jane@acme.example')).toBe('janeacmeexample');
    expect(matchKey('Ana Núñez')).toBe('ananunez');
    expect(matchKey('---')).toBe('');
  });

  it('takes the last extension off, and only that', () => {
    expect(fileStem('Jane Doe.jpg')).toBe('Jane Doe');
    expect(fileStem('jane@acme.example.jpg')).toBe('jane@acme.example');
    expect(fileStem('no-extension')).toBe('no-extension');
    expect(fileStem('.hidden')).toBe('.hidden');
  });
});

describe('matchPhoto', () => {
  it('matches the full name, the address, or the part before the @', () => {
    expect(matchPhoto('Jane Doe.jpg', PEOPLE)).toEqual({ kind: 'one', recipientId: 'r-jane' });
    expect(matchPhoto('jane_doe.png', PEOPLE)).toEqual({ kind: 'one', recipientId: 'r-jane' });
    expect(matchPhoto('jane@acme.example.jpg', PEOPLE)).toEqual({
      kind: 'one',
      recipientId: 'r-jane',
    });
    expect(matchPhoto('jane.jpeg', PEOPLE)).toEqual({ kind: 'one', recipientId: 'r-jane' });
    expect(matchPhoto('sam.lee.webp', PEOPLE)).toEqual({ kind: 'one', recipientId: 'r-sam' });
    expect(matchPhoto('SAM-LEE.HEIC', PEOPLE)).toEqual({ kind: 'one', recipientId: 'r-sam' });
    // The name from the merge values counts when the row has none, accents and all.
    expect(matchPhoto('ana nunez.gif', PEOPLE)).toEqual({ kind: 'one', recipientId: 'r-ana' });
  });

  it('leaves a name that fits nobody unmatched', () => {
    expect(matchPhoto('group-shot.png', PEOPLE)).toEqual({ kind: 'none' });
    expect(matchPhoto('Jane.Doe.2.jpg', PEOPLE)).toEqual({ kind: 'none' });
    expect(matchPhoto('.jpg', PEOPLE)).toEqual({ kind: 'none' });
    expect(matchPhoto('jane', [])).toEqual({ kind: 'none' });
  });

  it('never picks between two people a name fits: both are named and nobody gets it', () => {
    const twins: PhotoCandidate[] = [
      ...PEOPLE,
      { id: 'r-jane2', email: 'jdoe@other.example', name: 'Jane Doe' },
    ];
    expect(matchPhoto('Jane Doe.jpg', twins)).toEqual({
      kind: 'many',
      recipientIds: ['r-jane', 'r-jane2'],
    });
    // The same local part at two firms.
    const sameLocal: PhotoCandidate[] = [
      { id: 'a', email: 'pat@one.example', name: null },
      { id: 'b', email: 'pat@two.example', name: null },
    ];
    expect(matchPhoto('pat.png', sameLocal)).toEqual({ kind: 'many', recipientIds: ['a', 'b'] });
    // One person's name is another's address local part: still two people.
    const crossed: PhotoCandidate[] = [
      { id: 'a', email: 'robin@one.example', name: 'Robin Park' },
      { id: 'b', email: 'robinpark@two.example', name: 'R. P.' },
    ];
    expect(matchPhoto('robin_park.jpg', crossed)).toEqual({
      kind: 'many',
      recipientIds: ['a', 'b'],
    });
  });

  it('a file named for a full address is matched on that alone', () => {
    const shared: PhotoCandidate[] = [
      { id: 'a', email: 'pat@one.example', name: null },
      { id: 'b', email: 'pat@two.example', name: null },
    ];
    expect(matchPhoto('pat@two.example.jpg', shared)).toEqual({ kind: 'one', recipientId: 'b' });
  });

  it('a key that is one person’s address and another’s local part or name fits both', () => {
    // With the punctuation gone, "jo@park.example" and "joparkexample" read
    // the same: neither reading wins by being tried first.
    const crossed: PhotoCandidate[] = [
      { id: 'a', email: 'jo@park.example', name: null },
      { id: 'b', email: 'joparkexample@mail.example', name: null },
      { id: 'c', email: 'lee@kim.example', name: 'Lee Kim Example' },
    ];
    for (const name of ['joparkexample.jpg', 'jo@park.example.jpg']) {
      expect(matchPhoto(name, crossed)).toEqual({ kind: 'many', recipientIds: ['a', 'b'] });
    }
    // One person whose address and name read the same is still one person.
    expect(matchPhoto('Lee Kim Example.png', crossed)).toEqual({ kind: 'one', recipientId: 'c' });
    expect(
      matchPhoto('lee@kim.example.png', [
        ...crossed,
        { id: 'e', email: 'x@y.example', name: 'Lee Kim, Example' },
      ]),
    ).toEqual({ kind: 'many', recipientIds: ['c', 'e'] });
  });

  it('one matcher answers many photos', () => {
    const match = photoMatcher(PEOPLE);
    expect(['Jane Doe.jpg', 'Wei Chen.png', 'nobody.png'].map((n) => match(n).kind)).toEqual([
      'one',
      'one',
      'none',
    ]);
  });
});

describe('what counts as a photo', () => {
  it('by name: the image endings a campaign takes, any case', () => {
    for (const n of ['a.jpg', 'a.JPEG', 'a.png', 'a.gif', 'a.webp', 'a.heic']) {
      expect(isPhotoName(n)).toBe(true);
    }
    for (const n of ['a.pdf', 'a.svg', 'a.exe', 'jpg', 'a.jpg.exe']) {
      expect(isPhotoName(n)).toBe(false);
    }
    expect(isPhotoType('image/jpeg')).toBe(true);
    expect(isPhotoType('')).toBe(true);
    expect(isPhotoType('application/pdf')).toBe(false);
  });

  it('by its bytes: a renamed document is not a photo', () => {
    const bytes = (...b: number[]) => new Uint8Array(b);
    const text = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
    expect(sniffPhoto(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffPhoto(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png');
    expect(sniffPhoto(text('GIF89a....'))).toBe('gif');
    expect(sniffPhoto(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('webp');
    expect(sniffPhoto(text('\u0000\u0000\u0000\u0018ftypheic\u0000\u0000'))).toBe('heic');
    expect(sniffPhoto(text('%PDF-1.4'))).toBeNull();
    expect(sniffPhoto(text('MZ\u0090\u0000'))).toBeNull();
    expect(sniffPhoto(text('\u0000\u0000\u0000\u0018ftypavif'))).toBeNull();
    expect(sniffPhoto(bytes())).toBeNull();
  });
});

describe('the type a photo is stored with', () => {
  it('is always a real image type the bucket takes, never application/octet-stream', () => {
    for (const type of Object.values(PHOTO_MIME)) {
      expect(type).toMatch(/^image\//);
      expect(BUCKET_ALLOWED_MIME_TYPES).toContain(type);
    }
  });

  it('reads the kind an image type names, aliases included', () => {
    expect(photoKindOfType('image/jpeg')).toBe('jpeg');
    expect(photoKindOfType('image/jpg')).toBe('jpeg');
    expect(photoKindOfType('image/pjpeg')).toBe('jpeg');
    expect(photoKindOfType('Image/PNG')).toBe('png');
    expect(photoKindOfType('image/gif')).toBe('gif');
    expect(photoKindOfType('image/webp')).toBe('webp');
    expect(photoKindOfType('image/heic')).toBe('heic');
    expect(photoKindOfType('image/heif')).toBe('heic');
    for (const t of ['', 'application/octet-stream', 'image/bmp', 'application/pdf']) {
      expect(photoKindOfType(t)).toBeNull();
    }
  });

  it('reads the kind a file name ends in', () => {
    expect(photoKindOfName('Jane Doe.JPG')).toBe('jpeg');
    expect(photoKindOfName('jane.jpeg')).toBe('jpeg');
    expect(photoKindOfName('jane.heic')).toBe('heic');
    expect(photoKindOfName('jane.pdf')).toBeNull();
    expect(photoKindOfName('jane')).toBeNull();
  });

  it('takes the declared type first, the file name when the type says nothing', () => {
    // Windows sends a HEIC photo with no type, or application/octet-stream.
    expect(declaredPhotoKind('IMG_0042.HEIC', '')).toBe('heic');
    expect(declaredPhotoKind('IMG_0042.heic', 'application/octet-stream')).toBe('heic');
    // The composer declares what the bytes say, whatever the name.
    expect(declaredPhotoKind('Jane Doe.png', 'image/jpeg')).toBe('jpeg');
    // An image type no campaign takes says nothing either.
    expect(declaredPhotoKind('Jane Doe.png', 'image/x-png')).toBe('png');
    expect(declaredPhotoKind('notes.pdf', '')).toBeNull();
  });
});
