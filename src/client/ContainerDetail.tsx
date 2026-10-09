/**
 * 一个 plan 或 milestone 的全貌，连同它持有的一切。
 *
 * 内嵌列表就是外层列表：同样的行、同样的装饰，只有数据来源不同——它读的是容器持有的全部
 * （含已结算状态），而不是外层列表的过滤条件留在屏幕上的那些。
 */
import type { ReactElement } from 'react';

import type { ContainerDetail, IssueItem, MintListPayload, MintMetaPayload } from '../shared/records.js';
import { BodyView } from './Body.js';
import { ContainerRowView, IssueRow } from './Rows.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import type { LoadState } from './model.js';
import { containerRow, plansOfMilestone, statusTone } from './model.js';
import { BODY, BUTTON, META, NOTE, TOOLBAR, pill } from './styles.js';

export interface ContainerDetailProps {
  copy: CopyTranslate;
  kind: 'plan' | 'milestone';
  state: LoadState<ContainerDetail>;
  /** 容器所辖的 issue，按内嵌过滤条件读出。 */
  issues: LoadState<MintListPayload<IssueItem>>;
  /** 内嵌各行装饰所用的查表。 */
  meta: MintMetaPayload | undefined;
  onBack: () => void;
  onRefresh: () => void;
  onOpenIssue: (id: number) => void;
  onOpenPlan: (id: number) => void;
}

/** 内嵌的 issue 列表，复用外层那一套行组件。 */
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
  // milestone 的 plan 住在全状态查表里；没有这张表就没有一份完整的读数可显示。
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
