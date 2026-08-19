import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { api } from '../api/client';

/**
 * A product photo is a thumbnail on a phone screen, so 800px is plenty. A raw
 * 12MP camera shot is 3-5MB; downscaled and re-encoded it lands around 40-90KB,
 * which is what makes storing photos in MongoDB viable at all.
 */
const MAX_EDGE = 800;
const JPEG_QUALITY = 0.7;

export const PICK_CANCELLED = Symbol('cancelled');

async function ensurePermission(kind) {
  const request = kind === 'camera'
    ? ImagePicker.requestCameraPermissionsAsync
    : ImagePicker.requestMediaLibraryPermissionsAsync;

  const { granted, canAskAgain } = await request();
  if (granted) return;

  throw new Error(
    canAskAgain
      ? kind === 'camera' ? 'Camera permission is needed to take a photo'
        : 'Photo library permission is needed to choose a picture'
      : `Permission was denied. Enable ${kind === 'camera' ? 'Camera' : 'Photos'} for this app in your phone's Settings.`
  );
}

/** Opens the camera or gallery and returns the chosen asset, or PICK_CANCELLED. */
async function pick(source) {
  await ensurePermission(source);

  const options = {
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],   // square, matching how the cards display it
    quality: 1,       // compress once, during the resize step below
    exif: false,      // no GPS coordinates in a shop's product photo
  };

  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options);

  if (result.canceled || !result.assets?.length) return PICK_CANCELLED;
  return result.assets[0];
}

/**
 * Downscales and re-encodes to JPEG, returning base64 ready for upload.
 * Uses the current object-oriented manipulator API -- `manipulateAsync` still
 * exists but is deprecated in expo-image-manipulator 14.
 */
async function shrink(uri) {
  const context = ImageManipulator.manipulate(uri);
  context.resize({ width: MAX_EDGE });
  const rendered = await context.renderAsync();
  const output = await rendered.saveAsync({
    compress: JPEG_QUALITY,
    format: SaveFormat.JPEG,
    base64: true,
  });
  return { base64: output.base64, width: output.width, height: output.height, uri: output.uri };
}

/**
 * Pick -> downscale -> upload. Returns { imageId, url, localUri, bytes } so the
 * form can show the photo immediately from the local file while the remote copy
 * is what actually gets saved.
 *
 * Returns null when the user backs out.
 */
export async function pickAndUploadImage(source, { productId } = {}) {
  const asset = await pick(source);
  if (asset === PICK_CANCELLED) return null;

  const shrunk = await shrink(asset.uri);
  if (!shrunk.base64) throw new Error('Could not read the selected image');

  const res = await api.post('/images', {
    base64: shrunk.base64,
    contentType: 'image/jpeg',
    width: shrunk.width,
    height: shrunk.height,
    ...(productId && { productId }),
  });

  return {
    imageId: res.image._id,
    url: res.image.url,
    bytes: res.image.bytes,
    localUri: shrunk.uri, // instant preview, no round trip
  };
}

export async function deleteImage(imageId) {
  if (!imageId) return;
  await api.delete(`/images/${imageId}`);
}
