import { memo } from 'react';
import { clock, shortDateTime, tokens } from '../../../lib/format';
import { RUN_STATUS } from '../../../lib/status';
import { actions } from '../../../state/actions';
import { shallow } from '../../../state/store';
import { Badge, SimTag, StatusChip } from '../../ui';
import type { HistoryRow } from './historyData';

const HistoryTableRow = memo(function HistoryTableRow({ row }: { row: HistoryRow }) {
  return (
    <tr>
      <th scope="row" className="history-table__task">
        <button
          type="button"
          className="history-link"
          title={`${row.title}（打开这次运行）`}
          aria-label={`${row.title}，运行 #${row.attempt}`}
          onClick={() => actions.openTask(row.taskId, row.id)}
        >
          {row.title}
        </button>
      </th>
      <td>
        <span className="history-run">
          <span className="tabular">#{row.attempt}</span>
          {row.retryOf != null && (
            <Badge tone="info" title={row.retryOf > 0 ? `重试自运行 #${row.retryOf}` : '重试'}>重试</Badge>
          )}
        </span>
      </td>
      <td><StatusChip meta={RUN_STATUS[row.status]} size="sm" /></td>
      <td className="tabular">{shortDateTime(row.startedAt)}</td>
      <td className="is-num">{clock(row.activeMs)}</td>
      <td className="is-num">{row.stepsDone}/{row.stepsTotal}</td>
      <td className="is-num">{tokens(row.inputTokens + row.outputTokens)}</td>
      <td className="is-num">{row.artifacts}</td>
      <td><SimTag source={row.source} /></td>
    </tr>
  );
}, (a, b) => shallow(a.row, b.row));

/** The run history as a real table. Wide table scrolls inside its own region, never the page. */
export function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  return (
    <div className="history-scroll" role="region" aria-label="运行历史表格，可横向滚动" tabIndex={0}>
      <table className="history-table">
        <caption className="sr-only">运行历史</caption>
        <thead>
          <tr>
            <th scope="col">任务</th>
            <th scope="col">运行</th>
            <th scope="col">状态</th>
            <th scope="col">开始时间</th>
            <th scope="col" className="is-num">运行时间</th>
            <th scope="col" className="is-num">步骤</th>
            <th scope="col" className="is-num">Token</th>
            <th scope="col" className="is-num">产物</th>
            <th scope="col">来源</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <HistoryTableRow key={row.id} row={row} />)}
        </tbody>
      </table>
    </div>
  );
}
