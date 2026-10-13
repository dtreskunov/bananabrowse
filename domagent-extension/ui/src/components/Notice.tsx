import { failureMessage } from '../presentation';
export function Notice({ code }: { code: string | null | undefined }) {
  return <div id="error" role="alert" class={code ? 'notice' : 'notice empty'}>
    {code && <><span>{failureMessage(code)}</span>
      <details><summary>Failure details</summary><code>{code}</code></details></>}
  </div>;
}
