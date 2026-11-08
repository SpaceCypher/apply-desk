// The one icon set. Import icons from here so size and stroke stay consistent.
export {
  TriangleAlert, ArrowDown, ArrowUp, Briefcase, Check, ChevronLeft, ChevronRight, CircleAlert, Copy, Download, ExternalLink,
  Eye, FileText, Inbox, KeyRound, LayoutList, LogOut, Menu, MessageSquare, OctagonX, Play, Plus, RotateCcw,
  Search, Settings, ShieldCheck, Trash2, Upload, User, X, BarChart3, BookOpen, Camera, MousePointerClick, Send, Mail,
  CircleCheck, CircleDot, Ban, PenLine, Link2, Loader, Lightbulb, Gauge,
} from "lucide-react";
export const ICON = { size: 16, strokeWidth: 1.75 } as const;

// Lucide has no brand marks; this is GitHub's own mark, used only on the sign-in button.
export function GitHubMark({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>;
}

// Brand mark for Apply Desk: a simple stacked-forms glyph.
export function BrandMark({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
    <path d="M4 4.5h8M4 8h5M4 11.5h6.5" />
  </svg>;
}
