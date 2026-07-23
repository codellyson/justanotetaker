import { memo, type CSSProperties } from "react";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";
import { isTauri } from "../../../lib/runtime";
import type { TaskMeta, TaskStatus } from "../lib";
import { renderBody } from "../markdown";
import type { NoteFlowNode } from "./useNoteGraph";

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "queued",
  running: "running",
  done: "done",
  error: "failed",
};

// An agent job on the canvas. meta.status drives a chip; meta.prompt shows the
// work; on done the result markdown (note.text) renders below. In Tauri a Run
// button drives the local claude CLI (run_task command) when queued or errored.
// Tasks are created by agents (MCP create_task), not edited in place.
function TaskNodeInner({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note, dragging, dimmed, highlit, scrubFade, handlers } = data;
  const isConnectTarget = useConnection((c) => c.inProgress && c.fromNode?.id !== id);
  const meta = (note.meta ?? { status: "queued", prompt: "" }) as TaskMeta;
  const status = meta.status ?? "queued";

  const style: CSSProperties = {
    width: note.w ?? 300,
    opacity: scrubFade ?? 1,
  };
  const cls = [
    "task-card",
    `task-${status}`,
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
  ].filter(Boolean).join(" ");

  const canRun = isTauri && (status === "queued" || status === "error");

  return (
    <>
      <Handle type="target" position={Position.Left} className={"note-link-target" + (isConnectTarget ? " active" : "")} />
      <div className={cls} data-note-id={note.id} style={style}>
        <div className="task-head">
          <span className={"task-chip task-chip-" + status}>
            <span className="task-dot" aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
          {canRun && (
            <button
              type="button"
              className="task-run nodrag"
              onClick={(e) => {
                e.stopPropagation();
                handlers.onRunTask?.(note.id);
              }}
            >
              {status === "error" ? "Retry" : "Run"}
            </button>
          )}
        </div>

        {status === "done" && note.text ? (
          <div className="task-result">{renderBody(note.text)}</div>
        ) : (
          <div className="task-prompt">{meta.prompt || note.text}</div>
        )}

        {status === "error" && meta.error && <div className="task-error">{meta.error}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="note-link-source nodrag" isConnectable />
    </>
  );
}

export default memo(TaskNodeInner);
