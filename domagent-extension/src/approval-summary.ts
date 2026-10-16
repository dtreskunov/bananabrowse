import type { Wire } from '../../shared/protocol.js';

export function actionSummary(operation: string, args: Wire, page?: Wire | null, target?: Wire | null): string[] {
  const lines = [`Operation: ${operation}`];
  if (page) {
    lines.push(`Tab: ${page.title || 'Untitled'} (${new URL(page.url).origin})`);
  }
  if (args.selector) lines.push(`Selector: ${args.selector}`);
  if (args.ref) lines.push(`Element reference: ${args.ref}`);
  if (target) {
    lines.push(`Control: ${target.role || target.tag || 'element'} "${target.name || 'Unnamed'}"`);
    lines.push(`Readiness: ${target.state}`);
    if (target.activation?.kind === 'associated_label') {
      lines.push(`Activation: associated label "${target.activation.name || 'Unnamed'}".`);
    }
  } else if (args.selector || args.ref) {
    lines.push('Control not resolved yet; approval applies to the displayed selector/reference.');
  }
  if (operation === 'navigate') lines.push(`Destination: ${args.url}`);
  if (operation === 'type_text') lines.push(`Replace field value (${args.text.length} characters; value hidden).`);
  if (operation === 'select_option') lines.push('Select the requested option (value hidden).');
  if (operation === 'set_checked') lines.push(args.checked ? 'Set checked.' : 'Clear checked.');
  if (operation === 'press_key') lines.push(`Dispatch DOM key: ${args.key} (no native default action).`);
  if (operation === 'scroll') lines.push(`Scroll by ${args.delta_x || 0}, ${args.delta_y} pixels.`);
  if (operation === 'evaluate_script')
    lines.push(
      `Execute supplied page JavaScript (${args.script.length} characters). May read or change page data; source is not verified.`,
    );
  if (operation === 'request_handoff') lines.push('Wait for your Done confirmation; keep this tab shared.');
  return lines;
}
