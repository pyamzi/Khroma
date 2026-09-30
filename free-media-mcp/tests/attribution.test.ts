import { describe, expect, it } from 'vitest';
import { attribution, withAttribution } from '../src/attribution';
import { normalizeLicense } from '../src/license';
import type { MediaResult } from '../src/types';

const base = {
  media_type: 'image' as const, preview_url: 'p', full_url: 'f', width: 1, height: 1, duration_seconds: null, source: null,
};

const cc: MediaResult = withAttribution({
  ...base, id: 'openverse:1', provider: 'openverse',
  title: 'Bride & Groom', creator: 'PiktourUK', creator_url: 'https://www.flickr.com/photos/69706441@N03',
  source_page_url: 'https://www.flickr.com/photos/69706441@N03/33351721606',
  license: normalizeLicense('by', { version: '2.0', url: 'https://creativecommons.org/licenses/by/2.0/' }),
});

const pexels: MediaResult = withAttribution({
  ...base, id: 'pexels:2', provider: 'pexels', title: 'Two people', creator: 'Jane Doe',
  creator_url: 'https://www.pexels.com/@jane', source_page_url: 'https://www.pexels.com/photo/2/',
  license: normalizeLicense('pexels'),
});

const pixabayVideo: MediaResult = withAttribution({
  ...base, id: 'pixabay:video:3', provider: 'pixabay', media_type: 'video', duration_seconds: 12,
  title: null, creator: 'someuser', creator_url: 'https://pixabay.com/users/someuser-99/',
  source_page_url: 'https://pixabay.com/videos/id-3/', license: normalizeLicense('pixabay'),
});

describe('attribution', () => {
  it('text: TASL for CC, provider credit for Pexels/Pixabay, links appended', () => {
    expect(attribution(cc, 'text')).toBe(
      '"Bride & Groom" by PiktourUK is licensed under CC BY 2.0. Source: https://www.flickr.com/photos/69706441@N03/33351721606 License: https://creativecommons.org/licenses/by/2.0/',
    );
    expect(attribution(pexels, 'text')).toBe('Photo by Jane Doe on Pexels (https://www.pexels.com/photo/2/)');
    expect(attribution(pixabayVideo, 'text')).toBe('Video by someuser from Pixabay (https://pixabay.com/videos/id-3/)');
  });

  it('markdown: every element is a link', () => {
    expect(attribution(cc, 'markdown')).toBe(
      '"[Bride & Groom](https://www.flickr.com/photos/69706441@N03/33351721606)" by [PiktourUK](https://www.flickr.com/photos/69706441@N03) is licensed under [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/).',
    );
    expect(attribution(pexels, 'markdown')).toBe('Photo by [Jane Doe](https://www.pexels.com/@jane) on [Pexels](https://www.pexels.com/photo/2/)');
  });

  it('html: anchors with escaped text', () => {
    expect(attribution(cc, 'html')).toBe(
      '"<a href="https://www.flickr.com/photos/69706441@N03/33351721606">Bride &amp; Groom</a>" by <a href="https://www.flickr.com/photos/69706441@N03">PiktourUK</a> is licensed under <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>.',
    );
    expect(attribution(pixabayVideo, 'html')).toBe(
      'Video by <a href="https://pixabay.com/users/someuser-99/">someuser</a> from <a href="https://pixabay.com/videos/id-3/">Pixabay</a>',
    );
  });

  it('falls back when title or creator is missing and never emits a link without a URL', () => {
    const anon = withAttribution({ ...cc, title: null, creator: null, creator_url: null });
    expect(attribution(anon, 'markdown')).toBe(
      '"[Untitled](https://www.flickr.com/photos/69706441@N03/33351721606)" by Unknown creator is licensed under [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/).',
    );
  });

  it('names the Source for Openverse works in every format', () => {
    const commons = withAttribution({ ...cc, source: 'Wikimedia Commons' });
    expect(attribution(commons, 'text')).toBe(
      '"Bride & Groom" by PiktourUK via Wikimedia Commons is licensed under CC BY 2.0. Source: https://www.flickr.com/photos/69706441@N03/33351721606 License: https://creativecommons.org/licenses/by/2.0/',
    );
    expect(attribution(commons, 'markdown')).toContain('by [PiktourUK](https://www.flickr.com/photos/69706441@N03) via Wikimedia Commons is licensed under');
    expect(attribution(commons, 'html')).toContain('</a> via Wikimedia Commons is licensed under');
  });

  it('withAttribution sets attribution_text to the text format', () => {
    expect(cc.attribution_text).toBe(attribution(cc, 'text'));
  });
});
