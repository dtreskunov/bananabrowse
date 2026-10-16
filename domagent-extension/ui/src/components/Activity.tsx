import { feedStatus, operationLabel, timeOf } from '../presentation';
import type { Snapshot } from '../presentation';
import './Activity.css';

export function Activity({ snapshot }: { snapshot: Snapshot }) {
  // With a single agent its name on every row is noise.
  const names = new Map(snapshot.agents.length > 1 ? snapshot.agents.map((agent) => [agent.id, agent.name]) : []);
  const entries = [...snapshot.feed].reverse().slice(0, 50);
  if (!entries.length) return null;
  return (
    <section class="activity" aria-label="Activity">
      <div class="section-head">
        <h2>Activity</h2>
      </div>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id} class={`feed ${entry.status}`}>
            <time>{timeOf(entry.time)}</time>
            <div>
              <small class="muted">
                {[entry.agent_id && names.get(entry.agent_id), operationLabel(entry.operation)]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
              <p>{entry.description}</p>
            </div>
            {feedStatus(entry.status) && (
              <span
                class={`chip ${entry.status === 'failed' || entry.status === 'uncertain' ? 'bad' : ['needs_help', 'needs_approval'].includes(entry.status) ? 'warn' : ''}`}
              >
                {feedStatus(entry.status)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
