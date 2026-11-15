/**
 * `@assistant-ui/tap/react-shim` ships no types: it is React's hook API that runs as tap hooks inside
 * an assistant-ui runtime resource and as React hooks everywhere else, so React's signatures apply.
 */
declare module "@assistant-ui/tap/react-shim" {
  export { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
}
