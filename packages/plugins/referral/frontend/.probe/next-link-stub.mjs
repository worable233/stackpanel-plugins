export default function Link(props) { return props.children ?? null; }
export function redirect(url) { throw new Error("NEXT_REDIRECT;" + url); }
export function notFound() { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); }
export function usePathname() { return "/"; }
export function useSearchParams() { return new URLSearchParams(); }
