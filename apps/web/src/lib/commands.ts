export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
};

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  return commands.filter((c) => {
    const hay = (c.label + " " + (c.hint ?? "")).toLowerCase();
    return q.split(/\s+/).every((tok) => hay.includes(tok));
  });
}
