export function controlFrame(visible) {
  const selector = 'domagent-controlled-frame[data-domagent-control-frame]';
  for (const frame of document.querySelectorAll(selector)) frame.remove();
  if (!visible) return { visible: false };
  const frame = document.createElement('domagent-controlled-frame');
  frame.setAttribute('data-domagent-control-frame', '');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('inert', '');
  document.documentElement.append(frame);
  return { visible: true, url: location.href };
}
