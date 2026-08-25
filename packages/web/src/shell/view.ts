/**
 * The centre column's own display mode — orthogonal to `CanvasMode`
 * (canvas.ts's view/play). "grid" is not reachable yet in this ticket (no
 * button triggers it): it is declared now so #55's status-bar button and
 * `Stage.tsx`'s grid branch can land without reopening `App.tsx` (App.tsx
 * only ever passes this value through, never branches on "grid" itself).
 */
export type ShellView = "normal" | "grid";
