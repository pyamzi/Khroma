export const OV_IMAGE = {
  id: '575fdc8f-9f62-431c-a24d-9717001ff2ba',
  title: 'Bride and groom in Hanoi',
  foreign_landing_url: 'https://www.flickr.com/photos/69706441@N03/33351721606',
  url: 'https://live.staticflickr.com/752/33351721606_c98d0875a6_b.jpg',
  creator: 'PiktourUK',
  creator_url: 'https://www.flickr.com/photos/69706441@N03',
  license: 'by',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0/',
  provider: 'flickr',
  source: 'flickr',
  height: 837,
  width: 1024,
  thumbnail: 'https://api.openverse.org/v1/images/575fdc8f-9f62-431c-a24d-9717001ff2ba/thumb/',
};

export const OV_IMAGE_NC = { ...OV_IMAGE, id: 'nc-1', title: 'NC photo', license: 'by-nc', license_url: 'https://creativecommons.org/licenses/by-nc/2.0/' };

export const PX_PHOTO = {
  id: 2014422,
  width: 3024,
  height: 3024,
  url: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
  photographer: 'Joey Farina',
  photographer_url: 'https://www.pexels.com/@joey',
  alt: 'Brown Rocks During Golden Hour',
  src: {
    original: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg',
    large2x: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
    large: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    medium: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=350',
    small: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=130',
    portrait: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800',
    landscape: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200',
    tiny: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280',
  },
};

export const PX_VIDEO = {
  id: 2499611,
  width: 1080,
  height: 1920,
  url: 'https://www.pexels.com/video/2499611/',
  image: 'https://images.pexels.com/videos/2499611/free-video-2499611.jpg?fit=crop&w=1200&h=630',
  duration: 22,
  user: { id: 680589, name: 'Joey Farina', url: 'https://www.pexels.com/@joey' },
  video_files: [
    { id: 1, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, fps: 30, link: 'https://player.vimeo.com/external/hd.mp4' },
    { id: 2, quality: 'sd', file_type: 'video/mp4', width: 540, height: 960, fps: 30, link: 'https://player.vimeo.com/external/sd.mp4' },
    { id: 3, quality: 'hls', file_type: 'video/mp4', width: null, height: null, fps: null, link: 'https://player.vimeo.com/external/hls.m3u8' },
  ],
};

export const PB_IMAGE = {
  id: 195893,
  pageURL: 'https://pixabay.com/en/blossom-bloom-flower-195893/',
  type: 'photo',
  tags: 'blossom, bloom, flower',
  previewURL: 'https://cdn.pixabay.com/photo/2013/10/15/09/12/flower-195893_150.jpg',
  previewWidth: 150,
  previewHeight: 84,
  webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
  webformatWidth: 640,
  webformatHeight: 360,
  largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
  imageWidth: 4000,
  imageHeight: 2250,
  user: 'Josch13',
  user_id: 48777,
};

export const PB_VIDEO = {
  id: 125,
  pageURL: 'https://pixabay.com/videos/id-125/',
  type: 'film',
  tags: 'flowers, yellow, blossom',
  duration: 12,
  videos: {
    large: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.mp4', width: 1920, height: 1080, size: 6615235, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.jpg' },
    medium: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.mp4', width: 1280, height: 720, size: 3562083, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.jpg' },
    small: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.mp4', width: 640, height: 360, size: 1030736, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.jpg' },
    tiny: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_tiny.mp4', width: 480, height: 270, size: 1030736, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_tiny.jpg' },
  },
  user: 'Coverr-Free-Footage',
  user_id: 1281706,
};
