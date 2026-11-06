const { AgentError } = require('./platform');

function imageUrls(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new AgentError(
      'invalid_images',
      'Use images: ["https://…"] with at most four photo URLs.'
    );
  }
  return value.map(address => {
    let url;
    try {
      if (typeof address === 'string') url = new URL(address);
    } catch {
      // Report the input contract below.
    }
    if (
      !url ||
      address.length > 2048 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    ) {
      throw new AgentError(
        'invalid_images',
        'Each photo needs an HTTPS URL of at most 2048 characters, without embedded credentials.'
      );
    }
    return address;
  });
}

function imageContent(text, images = []) {
  return images.length
    ? [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
    : text;
}

module.exports = { imageUrls, imageContent };
