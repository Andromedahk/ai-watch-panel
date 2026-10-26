// Device adapters deliberately expose capabilities rather than arbitrary commands.
const DEVICES = Object.freeze({
  zhanyu: Object.freeze({ id: 'zhanyu', name: '展域 / TRYX PANORAMA SE', model: 'PASE_1021', width: 2240, height: 1080, maxPixels: 2240 * 1080 }),
});
const DEFAULT_STREAM_CONFIG = Object.freeze({ enabled: false, device: 'zhanyu', width: 2240, height: 1080,
  fps: 30, bitrateMbps: 8, pageSeconds: 12, showMascot: true });
const CONFIG_KEYS = Object.keys(DEFAULT_STREAM_CONFIG).filter(key => key !== 'enabled');
function validateStreamConfig(value, { partial = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stream configuration');
  if (Object.keys(value).some(key => !CONFIG_KEYS.includes(key))) throw new Error('Unknown stream setting');
  const next = { ...DEFAULT_STREAM_CONFIG, ...value };
  if (typeof next.device !== 'string' || !Object.hasOwn(DEVICES, next.device)) throw new Error('Unsupported screen device');
  for (const key of ['width', 'height', 'fps', 'bitrateMbps', 'pageSeconds']) if (!Number.isInteger(next[key])) throw new Error('Stream parameters must be integers');
  const validateArea = !partial || Object.hasOwn(value, 'width') && Object.hasOwn(value, 'height');
  if (next.width < 64 || next.width > 4096 || next.height < 64 || next.height > 4096 || next.width % 2 || next.height % 2 || validateArea && next.width * next.height > DEVICES[next.device].maxPixels) throw new Error('Invalid screen resolution');
  if (next.fps < 1 || next.fps > 60 || next.bitrateMbps < 1 || next.bitrateMbps > 50 || next.pageSeconds < 4 || next.pageSeconds > 120) throw new Error('Stream parameters out of range');
  if (typeof next.showMascot !== 'boolean') throw new Error('Invalid mascot setting');
  return Object.fromEntries((partial ? Object.keys(value) : CONFIG_KEYS).map(key => [key, next[key]]));
}
function streamPreferences(value) {
  try {
    const config = Object.fromEntries(CONFIG_KEYS.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
    return { ...DEFAULT_STREAM_CONFIG, ...validateStreamConfig(config), enabled: value?.enabled === true };
  } catch { return { ...DEFAULT_STREAM_CONFIG }; }
}
module.exports = { DEVICES, DEFAULT_STREAM_CONFIG, validateStreamConfig, streamPreferences };
