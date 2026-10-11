/**
 * plan DAG 面板：一个 tab、两个视图（规格见 `notes/plan-dag.md` 与 `notes/agent-tree.md`）。
 *
 * 它是**容器**：视图切换（`SegmentedControl`）、两条必读（DAG 与子代理树）的轮询、跳过重渲的
 * 整份读数守卫、以及一个共用的 1s 走秒时钟都在这里；两个视图（`DagGraphView` /
 * `AgentTreeBody`）各自只画自己的东西。
 *
 * 两条读各按自己的路由轮询，且**只有当前视图被读**：切到子代理树时 DAG 的那条 2s 请求停掉，
 * 反之亦然。切回来立即补读一次，所以「停掉」不会在面板上留下过期数字。
 *
 * 两个视图共用同一个 `now`：它是「上一次采样之后又过了多久」的浏览器半边，而两条路由共用同一
 * 个宿主采样钟（`sampled_at`），所以一个定时器就够，也只有一个。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';

import type { MintAgentsPayload, MintDagPayload, MintResponse } from '../shared/records.js';
import { AgentTreeBody } from './AgentTreeBody.js';
import { DagGraphView } from './DagGraphView.js';
import { StateNotice } from './StateNotice.js';
import { AGENT_COPY_KEYS, agentSummary } from './agent-tree-model.js';
import type { ReadSample } from './dag-sampler.js';
import { agentSampleOf, sameSample, sampleOf } from './dag-sampler.js';
import { dagCounts } from './dag-model.js';
import type { LoadState } from './model.js';
import { toLoadState } from './model.js';
import { BODY, DAG_SHELL, NOTE, TOOLBAR } from './styles.js';
import type { MintBodyProps, TabInfoLike } from './types.js';

const POLL_MS = 2000;

const TICK_MS = 1000;

/** 面板的两个视图：顺序即 `SegmentedControl` 的分段顺序。 */
export type PlanDagView = 'nodes' | 'subagents';

/** 打开面板先给 DAG：它是这个 tab 的本来面目，子代理树是第二眼。 */
export const DEFAULT_PLAN_DAG_VIEW: PlanDagView = 'nodes';

/** 切换控件的分段：与「正文预览 / 代码」同一个控件、同一套 id 契约。 */
export function viewOptions(
  copy: MintBodyProps['copy']
): readonly { value: PlanDagView; label: string }[] {
  return [
    { value: 'nodes', label: copy(AGENT_COPY_KEYS.tabNodes) },
    { value: 'subagents', label: copy(AGENT_COPY_KEYS.tabSubagents) },
  ];
}

/** The seat's hook; a stable no-op keeps the call unconditional in lean harnesses. */
const NO_TAB_INFO = (): TabInfoLike | undefined => undefined;

/**
 * 一条读的轮询：可见且被选中时每 2s 读一次，读数与上次全等就跳过写 state。
 *
 * `activeRef` 而不是 `active` 进依赖：切换视图会重启这个循环（于是切回来立即补读一次），但
 * 循环体内的判据是**当下**的选中态，不是启动那一刻的。
 */
function usePolledRead<T extends { ok: true }>(
  read: (signal: AbortSignal) => Promise<MintResponse<T>>,
  sample: (payload: T) => ReadSample,
  activeRef: { readonly current: boolean },
  visible: boolean,
  signal: AbortSignal | undefined,
  reload: number
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  // 面板最后接受的一次读数。用 ref 而非 state：它守的是一次写入、从不作画；而且它同时记住
  // revision 与样本，因为数据不动时数字仍在变。
  const last = useRef<ReadSample | undefined>(undefined);

  useEffect(() => {
    if (!visible || signal?.aborted === true) return;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', abort);
    const once = (): void => {
      void read(controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        // 同一份读数摆在同一组数字上：重设 state 只会重画同一张图并收掉一个打开的卡片。
        if (response.ok && sameSample(last.current, sample(response))) return;
        // 整份 payload 进 state——上面的守卫只为跳过写入，从不把旧样本并进新样本。失败的答案忘掉
        // 读数，这样恢复后的会话不会被误判成「同一样本」而一直停在提示上。
        last.current = response.ok ? sample(response) : undefined;
        setState(toLoadState(response));
      });
    };
    const tick = (): void => {
      if (activeRef.current) once();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
      clearInterval(timer);
    };
  }, [read, sample, activeRef, visible, signal, reload]);

  return state;
}

export function DagBody(props: MintBodyProps): ReactElement {
  const { api, copy, useTabInfo = NO_TAB_INFO } = props;
  const info = useTabInfo();
  const signal = info?.tab.signal;
  const visible = info?.tab.visible ?? true;
  const actions = info?.tab.actions;

  const [view, setView] = useState<PlanDagView>(DEFAULT_PLAN_DAG_VIEW);
  const [reload, setReload] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [hoveredAgent, setHoveredAgent] = useState<string | undefined>(undefined);
  // 切换控件按基 id 生成 tab 与它认领的面板 id（见 `Body.tsx`）：同一页面可以挂多个会话的
  // mint tab，故必须唯一。
  const viewId = useId();
  const activeRef = useRef(true);
  activeRef.current = visible && view === 'nodes';
  const agentsActiveRef = useRef(true);
  agentsActiveRef.current = visible && view === 'subagents';

  // 两条读各自的「读一次」：用 `useCallback` 稳定引用，否则轮询 effect 每次渲染都会重启。
  const readDag = useCallback((controller: AbortSignal) => api.dag(controller), [api]);
  const readAgents = useCallback((controller: AbortSignal) => api.agents(controller), [api]);
  const sampleDag = useCallback((payload: MintDagPayload) => sampleOf(payload), []);
  const sampleAgents = useCallback((payload: MintAgentsPayload) => agentSampleOf(payload), []);

  const dagState = usePolledRead(readDag, sampleDag, activeRef, visible, signal, reload);
  const agentsState = usePolledRead(
    readAgents,
    sampleAgents,
    agentsActiveRef,
    visible,
    signal,
    reload
  );

  // The tab's own refresh command: an explicit read bypasses the guard, so the
  // sample guard is reset by re-mounting the poll effects (the `reload` bump).
  useEffect(() => {
    if (actions === undefined) return;
    return actions.bindCommands({
      refresh: () => {
        setReload((count) => count + 1);
      },
    });
  }, [actions]);

  const dagPayload = dagState.status === 'ready' ? dagState.value : undefined;
  const agentsPayload = agentsState.status === 'ready' ? agentsState.value : undefined;

  // 只有真有东西在跑时才起定时器：安静的面板每秒重画一次是白费，而两个视图的走秒都锚在各自
  // 答案的 `sampled_at` 上。
  const dagLive =
    visible &&
    view === 'nodes' &&
    (dagPayload?.dag?.nodes.some((node) => node.status === 'running') ?? false);
  const agentsLive =
    visible && view === 'subagents' && (agentsPayload?.nodes.some((node) => node.running) ?? false);

  useEffect(() => {
    if (!dagLive && !agentsLive) return;
    // 第一次 tick 把 `now` 重新锚到浏览器钟上，于是这一行从样本的年龄开始走，而不是从挂载那一刻。
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [dagLive, agentsLive]);

  /** 该 agent 被哪些 DAG 节点认领过：纯查表，数据来自第一视图的文档。 */
  const dagNodesOf = (agentId: string): readonly string[] =>
    dagPayload?.dag?.nodes.filter((node) => node.agent === agentId).map((node) => node.id) ?? [];

  const toolbar =
    view === 'nodes'
      ? ((): string | undefined => {
          if (dagPayload?.dag == null) return undefined;
          const counts = dagCounts(dagPayload.dag);
          return `${copy('dag.count', { nodes: counts.nodes, edges: counts.edges })} · ${copy(
            'dag.runningCount',
            { count: counts.running }
          )}`;
        })()
      : agentsPayload === undefined
        ? undefined
        : agentSummary(agentsPayload, copy);

  const content = ((): ReactElement => {
    // 每个视图是一个自成一体的可滚动列：切换控件认领的就是下面这个 panel id。
    const panel = { padding: 0 };
    if (view === 'nodes') {
      return (
        <div
          id={`${viewId}-nodes-panel`}
          role="tabpanel"
          aria-labelledby={`${viewId}-nodes`}
          style={{ ...BODY, ...panel }}
        >
          <DagGraphView {...props} state={dagState} active={visible} />
        </div>
      );
    }
    if (agentsState.status === 'loading') return <StateNotice copy={copy} state="loading" />;
    if (agentsState.status === 'failed') {
      return (
        <StateNotice
          copy={copy}
          state="failed"
          message={agentsState.message}
          stderr={agentsState.stderr}
          onRetry={() => {
            setReload((count) => count + 1);
          }}
        />
      );
    }
    return (
      <div
        id={`${viewId}-subagents-panel`}
        role="tabpanel"
        aria-labelledby={`${viewId}-subagents`}
        style={{ ...BODY, ...panel }}
      >
        {agentsState.value.stale === true ? (
          <p style={{ ...NOTE, padding: '8px 10px 0', margin: 0 }}>
            {copy(AGENT_COPY_KEYS.stale, {
              at: new Date(agentsState.value.sampled_at).toLocaleTimeString(),
            })}
          </p>
        ) : undefined}
        <AgentTreeBody
          payload={agentsState.value}
          copy={copy}
          sampledAtMs={agentsState.value.sampled_at}
          nowMs={nowMs}
          hovered={hoveredAgent}
          onHover={setHoveredAgent}
          dagNodesOf={dagNodesOf}
        />
      </div>
    );
  })();

  return (
    <div style={DAG_SHELL}>
      <div style={TOOLBAR}>
        <SegmentedControl
          id={viewId}
          value={view}
          options={viewOptions(copy)}
          onChange={(next) => {
            setView(next);
            setHoveredAgent(undefined);
          }}
          label={copy(AGENT_COPY_KEYS.tabLabel)}
        />
        {toolbar !== undefined && <span style={NOTE}>{toolbar}</span>}
      </div>
      {content}
    </div>
  );
}
