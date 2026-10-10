import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Package } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons, resolveModuleIcon } from '../constants/appIcons';
import { useAuth } from '../context/AuthContext';
import { useModules } from '../context/ModulesContext';
import { useTheme } from '../context/ThemeContext';
import type { AdminModule, CurrentUser } from '../types';
import { loadRemoteModuleComponent } from '../utils/moduleFederation';
import { MODULE_THEME_STYLE_ID, moduleThemeCss } from '../styles/moduleTheme';
import { prefixAppPath } from '../utils/basePath';

function findModuleByRouteSlug(modules: AdminModule[], slug: string | undefined): AdminModule | null {
  if (!slug) {
    return null;
  }

  return modules.find((moduleEntry) => moduleEntry.routeSlug === slug || moduleEntry.slug === slug) ?? null;
}

interface HostedModuleProps {
  basePath: string;
  routePath: string;
  navigate: (path: string) => void;
  module: AdminModule;
  currentAdmin: CurrentUser;
  styleRoot?: ShadowRoot | Document;
  apiBasePath: string;
  standalone: boolean;
}

interface RemoteComponentState {
  key: string;
  component: ComponentType<HostedModuleProps>;
}

function getModuleBasePath(moduleEntry: AdminModule): string {
  return `/modules/${moduleEntry.routeSlug || moduleEntry.slug}`;
}

// Modules fetch their own API data via a host-supplied base path. Unlike basePath/routePath
// (which stay basename-relative so react-router's basename can add the /admin prefix), this is
// used directly in fetch() calls, so it needs the /admin prefix baked in explicitly.
function getModuleApiBasePath(moduleEntry: AdminModule): string {
  return prefixAppPath(`/api/modules/${moduleEntry.routeSlug || moduleEntry.slug}`, import.meta.env.BASE_URL);
}

function getHostedRemoteEntryUrl(remoteEntryUrl: string): string {
  return prefixAppPath(remoteEntryUrl, import.meta.env.BASE_URL);
}

function getRelativeModulePath(pathname: string, basePath: string): string {
  if (!pathname.startsWith(basePath)) {
    return '';
  }

  return pathname.slice(basePath.length).replace(/^\/+/, '');
}

function normalizeModulePath(path?: string): string {
  return (path ?? '').replace(/^\/+|\/+$/g, '');
}

function getModuleDefaultPath(moduleDefinition?: { defaultPath?: string; navigation?: Array<{ path?: string; children?: unknown[] }> }): string {
  const explicitDefault = normalizeModulePath(moduleDefinition?.defaultPath);
  if (explicitDefault) {
    return explicitDefault;
  }

  const navigation = moduleDefinition?.navigation ?? [];
  const stack = [...navigation];

  while (stack.length > 0) {
    const entry = stack.shift();
    if (!entry) {
      continue;
    }

    const entryPath = normalizeModulePath(entry.path);
    if (entryPath) {
      return entryPath;
    }

    // An empty-path entry with children is a group header — descend into it.
    // An empty-path leaf is the module's index/landing tab (e.g. an Overview),
    // so the index itself is the default: return '' to render it in place
    // rather than redirecting past it to the first non-empty sibling.
    if (Array.isArray(entry.children) && entry.children.length > 0) {
      stack.unshift(...entry.children as Array<{ path?: string; children?: unknown[] }>);
    } else {
      return '';
    }
  }

  return '';
}

export function ModuleHostPage() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { theme } = useTheme();
  const { modules, moduleDefinitions, isLoading } = useModules();
  const shadowHostRef = useRef<HTMLDivElement | null>(null);
  const moduleEntry = useMemo(() => findModuleByRouteSlug(modules, slug), [modules, slug]);
  const moduleDefinition = moduleEntry ? moduleDefinitions[moduleEntry.slug] : undefined;
  const [remoteComponentState, setRemoteComponentState] = useState<RemoteComponentState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shadowMount, setShadowMount] = useState<HTMLDivElement | null>(null);
  // Depend on primitives, not on the `moduleEntry` object. ModulesContext replaces the
  // `modules` array on every revalidation, which changes `moduleEntry`'s identity even when
  // its contents are unchanged. Depending on the object tore down and remounted the remote.
  const remoteEntryUrl = getHostedRemoteEntryUrl(moduleEntry?.remoteEntryUrl ?? '');
  const remoteScope = moduleEntry?.remoteScope ?? '';
  const exposedModule = moduleEntry?.exposedModule ?? '';
  const canHostRemote = Boolean(
    moduleEntry?.active
    && moduleEntry?.runtimeAvailable
    && remoteEntryUrl
    && remoteScope
    && exposedModule,
  );
  const basePath = moduleEntry ? getModuleBasePath(moduleEntry) : '';
  const apiBasePath = moduleEntry ? getModuleApiBasePath(moduleEntry) : '';
  const routePath = moduleEntry ? getRelativeModulePath(location.pathname, basePath) : '';
  const moduleDefaultPath = getModuleDefaultPath(moduleDefinition);
  const currentRemoteKey = moduleEntry
    ? `${moduleEntry.slug}:${moduleEntry.remoteEntryUrl ?? ''}:${moduleEntry.remoteScope ?? ''}:${moduleEntry.exposedModule ?? ''}`
    : 'module-host';
  const hostMountKey = currentRemoteKey;
  const ModuleIcon = moduleEntry ? resolveModuleIcon(moduleEntry) : appIcons.module;
  const hasHeaderBadges = Boolean(moduleEntry?.installedVersion) || Boolean(moduleEntry?.updateAvailable && moduleEntry.latestVersion);
  const headerBadges = moduleEntry && hasHeaderBadges ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {moduleEntry.installedVersion && (
        <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
          Installed v{moduleEntry.installedVersion}
        </span>
      )}
      {moduleEntry.updateAvailable && moduleEntry.latestVersion && (
        <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
          Update v{moduleEntry.latestVersion}
        </span>
      )}
    </div>
  ) : null;

  useEffect(() => {
    if (!canHostRemote) {
      setRemoteComponentState(null);
      return;
    }

    let cancelled = false;
    setLoadError(null);
    setRemoteComponentState((current) => (current?.key === currentRemoteKey ? current : null));

    loadRemoteModuleComponent(remoteEntryUrl, remoteScope, exposedModule)
      .then((component) => {
        if (!cancelled) {
          setRemoteComponentState({
            key: currentRemoteKey,
            component: component as ComponentType<HostedModuleProps>,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError((error as Error).message || 'Failed to load remote module');
          setRemoteComponentState(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canHostRemote, currentRemoteKey, exposedModule, remoteEntryUrl, remoteScope]);

  // Readiness is derived, so there is never a frame where the header renders with an empty
  // body: the spinner shows until the resolved component matches the current remote key.
  const readyRemote = remoteComponentState?.key === currentRemoteKey ? remoteComponentState : null;
  const showRemoteSpinner = canHostRemote && !loadError && !readyRemote;

  const handleShadowHostRef = useCallback((node: HTMLDivElement | null) => {
    shadowHostRef.current = node;
    if (!node) {
      setShadowMount(null);
      return;
    }

    const shadowRoot = node.shadowRoot ?? node.attachShadow({ mode: 'open' });

    // Inject the shared design system (tokens + component classes) so the module
    // inherits robin-admin's look inside its isolated shadow root. Injected first
    // so a module's own sheet can still layer on top.
    if (!shadowRoot.querySelector(`#${MODULE_THEME_STYLE_ID}`)) {
      const style = document.createElement('style');
      style.id = MODULE_THEME_STYLE_ID;
      style.textContent = moduleThemeCss;
      shadowRoot.prepend(style);
    }

    let mount = shadowRoot.querySelector<HTMLDivElement>('[data-module-shadow-mount="true"]');
    if (!mount) {
      mount = document.createElement('div');
      mount.dataset.moduleShadowMount = 'true';
      shadowRoot.appendChild(mount);
    }

    setShadowMount((current) => (current === mount ? current : mount));
  }, []);

  // Stamp the app theme on the shadow host so the injected tokens flip with it.
  useEffect(() => {
    if (shadowHostRef.current) {
      shadowHostRef.current.dataset.theme = theme;
    }
  }, [theme, shadowMount]);

  if (!slug) {
    return <Navigate to="/modules" replace />;
  }

  // Only block on the module catalog when there is nothing cached to render. When the slug is
  // already in the cached list the remote starts loading in parallel with the revalidation.
  if (isLoading && !moduleEntry) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  if (!moduleEntry) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.module}
          title="Module not found"
          description="This route does not match a synced module."
        />
        <div className="card p-8 text-center">
          <Package className="mx-auto h-10 w-10 text-gray-400" />
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            The module catalog does not contain a module for <code>{slug}</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!moduleEntry.installed || !moduleEntry.active || !moduleEntry.runtimeAvailable) {
    const unavailableMessage = !moduleEntry.installed
      ? 'This module is not installed on the current deployment.'
      : !moduleEntry.active
        ? (moduleEntry.activationMessage ?? 'The module must be installed and licensed before Robin Admin can host it.')
        : (moduleEntry.runtimeMessage ?? 'The module runtime is not reachable from Robin Admin right now.');

    return (
      <div className="space-y-6">
        <PageHeader
          icon={ModuleIcon}
          title={moduleEntry.displayName}
          description={moduleEntry.description ?? 'This module is not available on the current deployment yet.'}
          actions={headerBadges}
        />
        <div className="card p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-robin-orange" />
            <div>
              <h2 className="text-lg font-semibold">Module unavailable</h2>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                {unavailableMessage}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!routePath && moduleDefaultPath) {
    return <Navigate to={`${basePath}/${moduleDefaultPath}`} replace />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ModuleIcon}
        title={moduleEntry.displayName}
        description={moduleEntry.description ?? 'Hosted external module'}
        actions={headerBadges}
      />

      {showRemoteSpinner && (
        <div className="flex justify-center py-8">
          <Spinner className="text-robin-orange" />
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {loadError}
        </div>
      )}

      {!loadError && readyRemote && (
        <>
          <div key={hostMountKey} ref={handleShadowHostRef} />
          {shadowMount && createPortal(
            <readyRemote.component
              key={`${moduleEntry.slug}:${routePath || '__index__'}`}
              basePath={basePath}
              routePath={routePath}
              navigate={(path) => navigate(path)}
              module={moduleEntry}
              currentAdmin={user}
              apiBasePath={apiBasePath}
              standalone={false}
              styleRoot={shadowMount.getRootNode() instanceof ShadowRoot ? shadowMount.getRootNode() as ShadowRoot : document}
            />,
            shadowMount,
          )}
        </>
      )}
    </div>
  );
}
