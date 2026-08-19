import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock localStorage for Node.js 25 compatibility
// Node.js 25 provides a localStorage object but it's incomplete without --localstorage-file
// We override it with a proper mock that implements the full Storage interface
class LocalStorageMock implements Storage {
  private store: Map<string, string> = new Map();

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

global.localStorage = new LocalStorageMock();

// The @nostrify/react 0.6.6 NostrLoginProvider resolves stored logins on a
// microtask: it renders a null `fallback` on the first synchronous paint and
// only mounts its children once storage resolves. Component/hook tests render
// synchronously and query immediately, so they'd observe an empty tree (this is
// the sole cause of the render breakage introduced by the upgrade). Replace the
// provider — and the hook that reads its context — with a synchronous
// equivalent for tests, importing everything else (NLogin.nostrconnect and the
// connect helpers, whose handshake enforcement is the point of the upgrade;
// NUser) from the real module untouched.
vi.mock('@nostrify/react/login', async (importActual) => {
  const actual = await importActual<typeof import('@nostrify/react/login')>();
  const { createContext, useContext, useReducer, useEffect, createElement } = await import('react');

  const NostrLoginContext = createContext<unknown>(undefined);

  type Login = { id: string };
  type LoginAction =
    | { type: 'login.add'; login: Login; set?: boolean }
    | { type: 'login.remove'; id: string }
    | { type: 'login.set'; id: string }
    | { type: 'login.clear' };

  function reducer(state: Login[], action: LoginAction): Login[] {
    switch (action.type) {
      case 'login.add': {
        const filtered = state.filter((l) => l.id !== action.login.id);
        return action.set ? [action.login, ...filtered] : [...filtered, action.login];
      }
      case 'login.remove':
        return state.filter((l) => l.id !== action.id);
      case 'login.set': {
        const login = state.find((l) => l.id === action.id);
        if (!login) return state;
        return [login, ...state.filter((l) => l.id !== action.id)];
      }
      case 'login.clear':
        return [];
      default:
        return state;
    }
  }

  const NostrLoginProvider = ({ children, storageKey, storage = localStorage }: {
    children: React.ReactNode;
    storageKey: string;
    storage?: Storage;
  }) => {
    const [state, dispatch] = useReducer(reducer, undefined, (): Login[] => {
      const stored = storage.getItem(storageKey);
      return typeof stored === 'string' ? (JSON.parse(stored) as Login[]) : [];
    });
    useEffect(() => {
      storage.setItem(storageKey, JSON.stringify(state));
    }, [state, storageKey, storage]);
    const value = {
      logins: state,
      addLogin: (login: Login) => dispatch({ type: 'login.add', login }),
      removeLogin: (id: string) => dispatch({ type: 'login.remove', id }),
      setLogin: (id: string) => dispatch({ type: 'login.set', id }),
      clearLogins: () => dispatch({ type: 'login.clear' }),
    };
    return createElement(NostrLoginContext.Provider, { value }, children);
  };

  function useNostrLogin() {
    const context = useContext(NostrLoginContext);
    if (!context) {
      throw new Error('useNostrLogin must be used within a NostrLoginProvider');
    }
    return context;
  }

  return { ...actual, NostrLoginProvider, useNostrLogin };
});

// Mock CSS imports
vi.mock('*.css', () => ({}));
vi.mock('*.scss', () => ({}));
vi.mock('*.sass', () => ({}));

// Mock KaTeX CSS specifically
vi.mock('katex/dist/katex.min.css', () => ({}));

// Mock Streamdown component that might be importing KaTeX
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: React.ReactNode }) => children
}));

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock window.scrollTo
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
});

// Mock Element.scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock IntersectionObserver
class MockIntersectionObserver {
  root = null;
  rootMargin = '';
  thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock indexedDB for LightningFS
const mockIDBRequest = {
  result: null,
  error: null,
  onsuccess: null,
  onerror: null,
  readyState: 'done',
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};

const mockIDBDatabase = {
  name: 'test-db',
  version: 1,
  objectStoreNames: [],
  close: vi.fn(),
  createObjectStore: vi.fn(),
  deleteObjectStore: vi.fn(),
  transaction: vi.fn().mockReturnValue({
    objectStore: vi.fn().mockReturnValue({
      add: vi.fn().mockReturnValue(mockIDBRequest),
      put: vi.fn().mockReturnValue(mockIDBRequest),
      get: vi.fn().mockReturnValue(mockIDBRequest),
      delete: vi.fn().mockReturnValue(mockIDBRequest),
      clear: vi.fn().mockReturnValue(mockIDBRequest),
      count: vi.fn().mockReturnValue(mockIDBRequest),
      getAll: vi.fn().mockReturnValue(mockIDBRequest),
      getAllKeys: vi.fn().mockReturnValue(mockIDBRequest),
      index: vi.fn(),
      createIndex: vi.fn(),
      deleteIndex: vi.fn(),
    }),
    abort: vi.fn(),
    commit: vi.fn(),
    error: null,
    mode: 'readwrite',
    objectStoreNames: [],
    oncomplete: null,
    onerror: null,
    onabort: null,
  }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};

global.indexedDB = {
  open: vi.fn().mockReturnValue({
    ...mockIDBRequest,
    result: mockIDBDatabase,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  }),
  deleteDatabase: vi.fn().mockReturnValue(mockIDBRequest),
  databases: vi.fn().mockResolvedValue([]),
  cmp: vi.fn(),
};