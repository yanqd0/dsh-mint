/**
 * One plan or milestone in full, with everything it holds.
 *
 * The embedded lists are the outer lists: same rows, same decoration, only the
 * data source differs — they read everything the container holds (settled states
 * included) instead of whatever the outer list's filters left on screen.
 */
import type { ReactElement } from 'react';

import type { ContainerDetail, IssueItem, MintListPayload, MintMetaPayload } from '../records.js';
import { BodyView } from './Body.js';
import { ContainerRowView, IssueRow } from './Rows.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import type { LoadState } from './model.js';
import { containerRow, plansOfMilestone, statusTone } from './model.js';
import { BODY, BUTTON, META, NOTE, TOOLBAR, pill } from './styles.js';

export interface ContainerDetailProps {
  copy: CopyTranslate;
  /** Which kind the payload holds, for the heading. */
  kind: 'plan' | 'milestone';
  state: LoadState<ContainerDetail>;
  /** The issues the container holds, read with the embedded filter. */
  issues: LoadState<MintListPayload<IssueItem>>;
  /** The lookup tables the embedded rows are decorated from. */
  meta: MintMetaPayload | undefined;
  onBack: () => void;
  onRefresh: () => void;
  onOpenIssue: (id: number) => void;
  onOpenPlan: (id: number) => void;
}

/** One embedded list of issues, drawn with the outer row. */
function EmbeddedIssues({
  copy,
  state,
  meta,
  onRefresh,
  onOpenIssue,
}: {
  copy: CopyTranslate;
  state: LoadState<MintListPayload<IssueItem>>;
  meta: MintMetaPayload | undefined;
  onRefresh: () => void;
  onOpenIssue: (id: number) => void;
}): ReactElement {
  if (state.status !== 'ready') {
    return (
      <StateNotice
        copy={copy}
        state={state.status === 'loading' ? 'loading' : 'failed'}
        message={state.status === 'failed' ? state.message : undefined}
        stderr={state.status === 'failed' ? state.stderr : undefined}
        onRetry={onRefresh}
      />
    );
  }
  const { items, total } = state.value;
  if (items.length === 0) return <p style={NOTE}>{copy('state.empty')}</p>;
  return (
    <>
      {items.map((item) => (
        <IssueRow
          key={item.id}
          copy={copy}
          item={item}
          meta={meta}
          onSelect={(next) => {
            onOpenIssue(next.id);
          }}
        />
      ))}
      {total > items.length && (
        <p style={NOTE}>{copy('panel.embeddedLimited', { shown: items.length })}</p>
      )}
    </>
  );
}

/**
 * Render the container.
 *
 * @param props - copy, kind, loaded state, the lookup tables, and the callbacks.
 */
export function ContainerDetail({
  copy,
  kind,
  state,
  issues,
  meta,
  onBack,
  onRefresh,
  onOpenIssue,
  onOpenPlan,
}: ContainerDetailProps): ReactElement {
  const back = (
    <div style={TOOLBAR}>
      <button type="button" style={BUTTON} onClick={onBack}>
        {copy('detail.back')}
      </button>
      <button type="button" style={BUTTON} onClick={onRefresh}>
        {copy('panel.refresh')}
      </button>
    </div>
  );

  if (state.status !== 'ready') {
    return (
      <>
        {back}
        <StateNotice
          copy={copy}
          state={state.status === 'loading' ? 'loading' : 'failed'}
          message={state.status === 'failed' ? state.message : undefined}
          stderr={state.status === 'failed' ? state.stderr : undefined}
          onRetry={onRefresh}
        />
      </>
    );
  }

  const item = state.value;
  const heading = `#${String(item.id)} ${item.title}`;
  // A milestone's plans live in the all-states lookup table; without it there is
  // no complete read to show.
  const plans = kind === 'milestone' ? plansOfMilestone(meta, item.id) : undefined;

  return (
    <>
      {back}
      <div style={BODY}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{heading}</div>
        <div style={{ ...META, marginTop: 6 }}>
          <span>{copy(kind === 'plan' ? 'container.plan' : 'container.milestone')}</span>
          <span style={pill(statusTone(item.status))}>{item.status}</span>
          {item.version !== null && (
            <span>{copy('detail.version', { version: item.version })}</span>
          )}
          {item.milestone_id !== null && (
            <span>{copy('detail.milestone', { id: item.milestone_id })}</span>
          )}
          <span>{copy('detail.updated', { at: item.updated_at })}</span>
        </div>
        <BodyView copy={copy} body={item.body} />

        {kind === 'milestone' && (
          <>
            <div style={{ ...NOTE, marginTop: 12 }}>{copy('detail.plans')}</div>
            {plans === undefined ? (
              <p style={NOTE}>{copy('panel.metaUnavailable')}</p>
            ) : plans.length === 0 ? (
              <p style={NOTE}>{copy('state.empty')}</p>
            ) : (
              plans.map((plan) => (
                <ContainerRowView
                  key={plan.id}
                  row={containerRow(plan, copy)}
                  onSelect={() => {
                    onOpenPlan(plan.id);
                  }}
                />
              ))
            )}
          </>
        )}

        <div style={{ ...NOTE, marginTop: 12 }}>{copy('detail.issues')}</div>
        <EmbeddedIssues
          copy={copy}
          state={issues}
          meta={meta}
          onRefresh={onRefresh}
          onOpenIssue={onOpenIssue}
        />
      </div>
    </>
  );
}
