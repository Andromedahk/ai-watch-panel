const RATIO = 4.5;
const COLLAPSED_WIDTH = 46;

function panelBounds(workArea, side = 'right', collapsed = false) {
  const width = collapsed ? COLLAPSED_WIDTH : Math.max(1, Math.round(workArea.height / RATIO));
  return {
    x: side === 'left' ? workArea.x : workArea.x + workArea.width - width,
    y: workArea.y, width, height: workArea.height,
  };
}

function clampBounds(bounds, workArea) {
  return {
    ...bounds,
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height))),
  };
}

function validPreferences(value) {
  return {
    side: value?.side === 'left' ? 'left' : 'right',
    locked: value?.locked === true,
    animate: value?.animate !== false,
  };
}

module.exports = { panelBounds, clampBounds, validPreferences, RATIO, COLLAPSED_WIDTH };
