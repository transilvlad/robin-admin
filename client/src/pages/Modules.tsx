import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, KeyRound, Package, Play, RefreshCw, ShoppingCart, Square, Trash2 } from 'lucide-react';
import { ApiError, modulesApi } from '../api/client';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons, resolveModuleIcon } from '../constants/appIcons';
import { useAuth } from '../context/AuthContext';
import { useModules } from '../context/ModulesContext';
import type {
  AdminModule,
  ModuleActivationStatus,
  ModuleInstallerAction,
  ModuleInstallerResult,
  ModuleRuntimeStatus,
} from '../types';

interface CatalogPublisherMetadata {
  displayName: string;
  verified: boolean;
  kind?: string;
}

interface CatalogDeliveryMetadata {
  mode?: string;
  available: boolean;
  services: Array<{ name: string; digest: string }>;
}

function readPublisher(metadata: Record<string, unknown>): CatalogPublisherMetadata | null {
  const value = metadata.publisher;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const publisher = value as Record<string, unknown>;
  if (typeof publisher.displayName !== 'string' || publisher.verified !== true) return null;
  return {
    displayName: publisher.displayName,
    verified: true,
    kind: typeof publisher.kind === 'string' ? publisher.kind : undefined,
  };
}

function readDelivery(metadata: Record<string, unknown>): CatalogDeliveryMetadata | null {
  const value = metadata.delivery;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const delivery = value as Record<string, unknown>;
  if (typeof delivery.available !== 'boolean' || !Array.isArray(delivery.services)) return null;
  return {
    mode: typeof delivery.mode === 'string' ? delivery.mode : undefined,
    available: delivery.available,
    services: delivery.services.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const service = entry as Record<string, unknown>;
      return typeof service.name === 'string' && typeof service.digest === 'string'
        ? [{ name: service.name, digest: service.digest }]
        : [];
    }),
  };
}

function readPermissions(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.permissions)
    ? metadata.permissions.filter((value): value is string => typeof value === 'string')
    : [];
}

function readMetadataUrl(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readMetadataUrlArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function isDeprecated(metadata: Record<string, unknown>): boolean {
  return metadata.status === 'deprecated';
}

function ModuleGallery({ images, displayName }: { images: string[]; displayName: string }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hiddenImages, setHiddenImages] = useState<Set<number>>(() => new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const visibleIndex = hiddenImages.has(activeIndex)
    ? images.findIndex((_, index) => !hiddenImages.has(index))
    : activeIndex;

  if (visibleIndex === -1) return null;

  const closeLightbox = () => setLightboxIndex(null);
  const showPrev = () =>
    setLightboxIndex((current) => (current === null ? current : (current - 1 + images.length) % images.length));
  const showNext = () =>
    setLightboxIndex((current) => (current === null ? current : (current + 1) % images.length));

  return (
    <>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => setLightboxIndex(visibleIndex)}
          aria-label={`Zoom into ${displayName} preview ${visibleIndex + 1}`}
          className="flex h-36 w-56 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-100 dark:border-robin-gray-700 dark:bg-robin-gray-800/60"
        >
          <img
            src={images[visibleIndex]}
            alt={`${displayName} preview ${visibleIndex + 1}`}
            loading="lazy"
            className="max-h-full max-w-full object-contain"
            onError={() => setHiddenImages((current) => new Set(current).add(visibleIndex))}
          />
        </button>
        {images.length > 1 && (
          <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
            {images.map((image, index) => (
              !hiddenImages.has(index) && (
                <button
                  key={image}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  aria-label={`Show screenshot ${index + 1} of ${images.length}`}
                  aria-current={index === visibleIndex}
                  className={`h-8 w-11 shrink-0 overflow-hidden rounded-md border ${
                    index === visibleIndex ? 'border-robin-orange' : 'border-gray-200 dark:border-robin-gray-700'
                  }`}
                >
                  <img
                    src={image}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={() => setHiddenImages((current) => new Set(current).add(index))}
                  />
                </button>
              )
            ))}
          </div>
        )}
      </div>
      {lightboxIndex !== null && (
        <Modal
          isOpen
          onClose={closeLightbox}
          title={`${displayName} \u2014 screenshot ${lightboxIndex + 1} of ${images.length}`}
          size="xl"
        >
          <div className="relative flex items-center justify-center">
            {images.length > 1 && (
              <button
                type="button"
                onClick={showPrev}
                aria-label="Previous screenshot"
                className="absolute left-0 rounded-full bg-white/80 p-2 shadow-sm hover:bg-white dark:bg-robin-gray-700/80 dark:hover:bg-robin-gray-700"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <img
              src={images[lightboxIndex]}
              alt={`${displayName} preview ${lightboxIndex + 1}`}
              className="max-h-[70vh] w-full object-contain"
            />
            {images.length > 1 && (
              <button
                type="button"
                onClick={showNext}
                aria-label="Next screenshot"
                className="absolute right-0 rounded-full bg-white/80 p-2 shadow-sm hover:bg-white dark:bg-robin-gray-700/80 dark:hover:bg-robin-gray-700"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function installerProgress(job: ModuleInstallerResult): number | null {
  const progress = job.data?.progress;
  return typeof progress === 'number' && Number.isFinite(progress)
    ? Math.max(0, Math.min(100, progress))
    : null;
}

function installerError(job: ModuleInstallerResult): string | null {
  const error = job.data?.error;
  return typeof error === 'string' && error.trim() ? error : job.message;
}

const activationBadgeClasses: Record<ModuleActivationStatus, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  grace: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  'license-required': 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  expired: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  invalid: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  'not-installed': 'bg-gray-100 text-gray-700 dark:bg-robin-gray-700 dark:text-gray-200',
};

const runtimeBadgeClasses: Record<ModuleRuntimeStatus, string> = {
  reachable: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  unreachable: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  unknown: 'bg-gray-100 text-gray-700 dark:bg-robin-gray-700 dark:text-gray-200',
};

function activationLabel(status: ModuleActivationStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'grace':
      return 'Offline grace';
    case 'license-required':
      return 'License required';
    case 'expired':
      return 'Expired';
    case 'invalid':
      return 'Invalid license';
    case 'not-installed':
      return 'Not installed';
    default:
      return status;
  }
}

function runtimeLabel(status: ModuleRuntimeStatus): string {
  switch (status) {
    case 'reachable':
      return 'Runtime reachable';
    case 'unreachable':
      return 'Runtime offline';
    case 'unknown':
      return 'Runtime unknown';
    default:
      return status;
  }
}

function ModuleCard({
  moduleEntry,
  isAdmin,
  isActivating,
  isRefreshingLicense,
  installerAction,
  installerJob,
  licenseKey,
  onLicenseKeyChange,
  onActivate,
  onRefreshLicense,
  onInstallerAction,
}: {
  moduleEntry: AdminModule;
  isAdmin: boolean;
  isActivating: boolean;
  isRefreshingLicense: boolean;
  installerAction: ModuleInstallerAction | null;
  installerJob: ModuleInstallerResult | null;
  licenseKey: string;
  onLicenseKeyChange: (value: string) => void;
  onActivate: () => void;
  onRefreshLicense: () => void;
  onInstallerAction: (action: ModuleInstallerAction) => void;
}) {
  const ModuleIcon = resolveModuleIcon(moduleEntry);
  const publisher = readPublisher(moduleEntry.metadata);
  const delivery = readDelivery(moduleEntry.metadata);
  const permissions = readPermissions(moduleEntry.metadata);
  const imageUrl = readMetadataUrl(moduleEntry.metadata, 'imageUrl');
  const imageUrls = readMetadataUrlArray(moduleEntry.metadata, 'imageUrls');
  const galleryImages = imageUrl ? [imageUrl, ...imageUrls.filter((url) => url !== imageUrl)] : imageUrls;
  const purchaseUrl = readMetadataUrl(moduleEntry.metadata, 'purchaseUrl');
  const deprecated = isDeprecated(moduleEntry.metadata);
  const deliveryUnavailable = delivery?.available === false;
  const vendorLabel = publisher?.displayName ?? moduleEntry.vendorName ?? 'Robin';
  const detailPills = [
    moduleEntry.tier === 'paid' ? 'Paid' : 'Free',
    moduleEntry.installed
      ? `Installed${moduleEntry.installedSource ? ` (${moduleEntry.installedSource})` : ''}`
      : 'Not installed',
    moduleEntry.installed && moduleEntry.installedVersion ? `Installed v${moduleEntry.installedVersion}` : null,
    moduleEntry.updateAvailable && moduleEntry.latestVersion ? `Latest v${moduleEntry.latestVersion}` : null,
    !moduleEntry.installed && moduleEntry.latestVersion ? `Latest v${moduleEntry.latestVersion}` : null,
    moduleEntry.licenseKeyLast4 ? `••••${moduleEntry.licenseKeyLast4}` : null,
    moduleEntry.leaseExpiresAt ? `Lease until ${new Date(moduleEntry.leaseExpiresAt).toLocaleString()}` : null,
    moduleEntry.offlineGraceEndsAt ? `Grace until ${new Date(moduleEntry.offlineGraceEndsAt).toLocaleString()}` : null,
    typeof moduleEntry.replacementAllowance === 'number' && typeof moduleEntry.replacementsUsed === 'number'
      ? `Replacements ${moduleEntry.replacementsUsed}/${moduleEntry.replacementAllowance}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const technicalSummary = [moduleEntry.remoteScope, moduleEntry.exposedModule].filter(Boolean).join(' · ');
  const installerActions = moduleEntry.installerActions ?? [];
  const showInstallerAction = isAdmin && installerActions.length > 0;
  const showPurchaseLink = moduleEntry.tier === 'paid' && Boolean(purchaseUrl);
  const purchaseLinkLabel = moduleEntry.installed ? 'Licensing' : 'Purchase';
  const progress = installerJob ? installerProgress(installerJob) : null;

  return (
    <article className="card p-4 space-y-4">
      {deprecated && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          This module is deprecated. It remains available, but the publisher recommends migrating away from it.
        </div>
      )}
      <div className="flex items-start gap-4">
        {galleryImages.length > 0 && (
          <ModuleGallery images={galleryImages} displayName={moduleEntry.displayName} />
        )}
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-robin-orange/10 text-robin-orange dark:bg-robin-orange/15">
            <ModuleIcon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{moduleEntry.displayName}</h2>
              <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${activationBadgeClasses[moduleEntry.activationStatus]}`}>
                {activationLabel(moduleEntry.activationStatus)}
              </span>
              <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${runtimeBadgeClasses[moduleEntry.runtimeStatus]}`}>
                {runtimeLabel(moduleEntry.runtimeStatus)}
              </span>
            </div>
            <p className="max-w-2xl text-sm text-gray-500 dark:text-gray-400">
              {moduleEntry.description || 'No description published for this module yet.'}
            </p>
            <div className="flex flex-wrap gap-2 text-xs text-gray-600 dark:text-gray-300">
              {detailPills.map((pill) => (
                <span
                  key={pill}
                  className="inline-flex rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-robin-gray-700 dark:bg-robin-gray-800"
                >
                  {pill}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm dark:border-robin-gray-800 dark:bg-robin-gray-800/40 sm:grid-cols-3">
        <div>
          <div className="text-xs font-medium text-gray-400">Publisher</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 font-medium text-gray-700 dark:text-gray-200">
            <span>{vendorLabel}</span>
            {publisher && (
              <span className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                Verified{publisher.kind ? ` · ${publisher.kind}` : ''}
              </span>
            )}
          </div>
        </div>
        {delivery && (
          <div>
            <div className="text-xs font-medium text-gray-400">Delivery</div>
            <div className={`mt-1 font-medium ${delivery.available ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
              {delivery.available ? 'Available' : 'Unavailable'}
              {delivery.mode ? ` (${delivery.mode})` : ''}
            </div>
          </div>
        )}
        {technicalSummary && (
          <div>
            <div className="text-xs font-medium text-gray-400">Runtime</div>
            <div className="mt-1 font-medium text-gray-700 dark:text-gray-200">
              <code className="text-xs">{technicalSummary}</code>
            </div>
          </div>
        )}
      </div>

      {(permissions.length > 0 || (delivery && delivery.services.length > 0)) && (
        <div className="space-y-3 text-sm">
          {permissions.length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-400">Permissions required</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {permissions.map((permission) => (
                  <code key={permission} className="rounded-sm border border-gray-200 bg-gray-50 px-2 py-1 text-xs dark:border-robin-gray-700 dark:bg-robin-gray-800">
                    {permission}
                  </code>
                ))}
              </div>
            </div>
          )}
          {delivery && delivery.services.length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-400">Signatures</div>
              <div className="mt-2 space-y-1 rounded-lg border border-gray-100 bg-gray-50 p-3 font-mono text-xs text-gray-500 dark:border-robin-gray-800 dark:bg-robin-gray-800/40 dark:text-gray-400">
                {delivery.services.map((service) => (
                  <div key={`${service.name}:${service.digest}`} className="break-all">
                    <span className="font-medium">{service.name}:</span> <code>{service.digest}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {moduleEntry.activationMessage && !(moduleEntry.requiresLicense && moduleEntry.runtimeAvailable && moduleEntry.activationStatus !== 'active') && (
        <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-700 dark:bg-robin-gray-800 dark:text-gray-200">
          {moduleEntry.activationMessage}
        </div>
      )}

      {moduleEntry.lastValidationError && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          moduleEntry.activationStatus === 'active' || moduleEntry.activationStatus === 'grace'
            ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
            : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
        }`}>
          {moduleEntry.lastValidationError}
          {' '}
          {moduleEntry.refreshFailureTerminal
            ? 'Access is disabled. Refresh after correcting the license or reactivate with a valid key.'
            : 'Robin Admin will retry automatically; verify Sheriff connectivity if this persists.'}
        </div>
      )}

      {moduleEntry.requiresLicense && (
        <dl className="grid gap-3 border-t border-gray-100 pt-3 text-sm dark:border-robin-gray-800 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-gray-500">License authority</dt>
            <dd className="break-all">{moduleEntry.licenseAuthorityUrl ?? moduleEntry.configuredAuthorityUrl}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Deployment</dt>
            <dd className="break-all">{moduleEntry.deploymentLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Last validated</dt>
            <dd>{moduleEntry.lastValidatedAt ? new Date(moduleEntry.lastValidatedAt).toLocaleString() : 'Not validated'}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <dt className="text-xs text-gray-500">Lease state</dt>
              <dd>{moduleEntry.activationStatus === 'grace' ? 'Offline grace' : moduleEntry.active ? 'Cached lease' : 'No usable lease'}</dd>
            </div>
            {isAdmin && moduleEntry.licenseKeyLast4 && (
              <button type="button" onClick={onRefreshLicense}
                className="btn btn-secondary flex h-8 w-8 shrink-0 items-center justify-center p-0"
                disabled={isActivating || isRefreshingLicense} aria-busy={isRefreshingLicense}
                title="Validate and renew license" aria-label={`Validate and renew ${moduleEntry.displayName} license`}>
                <RefreshCw className={`h-4 w-4 ${isRefreshingLicense ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </dl>
      )}

      {(showInstallerAction || showPurchaseLink) && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4 dark:border-robin-gray-800">
          {showPurchaseLink && (
            <a
              href={purchaseUrl ?? undefined}
              target={purchaseUrl?.startsWith('mailto:') ? undefined : '_blank'}
              rel={purchaseUrl?.startsWith('mailto:') ? undefined : 'noreferrer'}
              className="btn btn-secondary inline-flex items-center gap-2 px-4 py-2"
              onClick={() => {
                // Fire-and-forget; never block or fail the navigation on this.
                void modulesApi.recordPurchaseClick(moduleEntry.slug).catch(() => undefined);
              }}
            >
              <ShoppingCart className="h-4 w-4" />
              {purchaseLinkLabel}
            </a>
          )}
          {showInstallerAction && (
          <>
          {!moduleEntry.installed ? (
            <Button
              onClick={() => onInstallerAction('install')}
              isLoading={installerAction === 'install'}
              disabled={deliveryUnavailable || installerAction !== null}
              title={deliveryUnavailable ? 'Publisher delivery is currently unavailable.' : undefined}
            >
              <Download className="h-4 w-4" />
              Install
            </Button>
          ) : (
            <>
              {moduleEntry.updateAvailable && installerActions.includes('upgrade') && (
                <Button
                  variant="secondary"
                  onClick={() => onInstallerAction('upgrade')}
                  isLoading={installerAction === 'upgrade'}
                  disabled={deliveryUnavailable || installerAction !== null}
                >
                  <RefreshCw className="h-4 w-4" />
                  Update
                </Button>
              )}
              {moduleEntry.runtimeAvailable ? (
                <Button variant="secondary" onClick={() => onInstallerAction('stop')} isLoading={installerAction === 'stop'} disabled={installerAction !== null}>
                  <Square className="h-4 w-4" />
                  Stop
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => onInstallerAction('start')} isLoading={installerAction === 'start'} disabled={installerAction !== null}>
                  <Play className="h-4 w-4" />
                  Start
                </Button>
              )}
              <Button variant="danger" onClick={() => onInstallerAction('uninstall')} isLoading={installerAction === 'uninstall'} disabled={installerAction !== null}>
                <Trash2 className="h-4 w-4" />
                Uninstall
              </Button>
            </>
          )}
          </>
          )}
        </div>
      )}

      {installerJob && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          installerJob.status === 'failed'
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
            : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300'
        }`}>
          <div className="font-medium">
            {installerJob.action} · {installerJob.status}
            {progress !== null ? ` · ${progress}%` : ''}
          </div>
          {(installerError(installerJob) || installerJob.message) && (
            <div className="mt-1">{installerError(installerJob) ?? installerJob.message}</div>
          )}
          {progress !== null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10">
              <div className="h-full bg-current transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      )}

      {isAdmin && moduleEntry.requiresLicense && moduleEntry.activationStatus !== 'active'
        && (moduleEntry.installed ? moduleEntry.runtimeAvailable : true) && (
        <div className="rounded-2xl border border-gray-200 p-4 dark:border-robin-gray-700">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4 text-robin-orange" />
            License activation
          </div>
          {!moduleEntry.installed && (
            <p className="mt-1 text-xs text-gray-500 dark:text-robin-gray-400">
              Activate your license first to unlock installation of this paid module.
            </p>
          )}
          <div className="mt-3 flex flex-col gap-3 lg:flex-row">
            <input
              type="text"
              className="input flex-1"
              placeholder={`Paste a ${moduleEntry.displayName} license key`}
              value={licenseKey}
              onChange={(event) => onLicenseKeyChange(event.target.value)}
            />
            <Button onClick={onActivate} disabled={!licenseKey.trim()} isLoading={isActivating}>
              Activate
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

export function ModulesPage() {
  const { user } = useAuth();
  const { modules, isLoading, error, refresh, updateModule } = useModules();
  const [syncError, setSyncError] = useState<string | null>(null);
  const [moduleNotice, setModuleNotice] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activatingSlug, setActivatingSlug] = useState<string | null>(null);
  const [refreshingLicenseSlug, setRefreshingLicenseSlug] = useState<string | null>(null);
  const [installerAction, setInstallerAction] = useState<{ slug: string; action: ModuleInstallerAction } | null>(null);
  const [installerJobs, setInstallerJobs] = useState<Record<string, ModuleInstallerResult>>({});
  const [licenseInputs, setLicenseInputs] = useState<Record<string, string>>({});
  const [maintenanceModule, setMaintenanceModule] = useState<AdminModule | null>(null);
  const [maintenanceAcknowledged, setMaintenanceAcknowledged] = useState(false);
  const isAdmin = user?.role === 'admin';

  const summary = useMemo(() => ({
    total: modules.length,
    installed: modules.filter((moduleEntry) => moduleEntry.installed).length,
    hostable: modules.filter((moduleEntry) => moduleEntry.active && moduleEntry.runtimeAvailable).length,
    paid: modules.filter((moduleEntry) => moduleEntry.tier === 'paid').length,
  }), [modules]);

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncError(null);
    setModuleNotice(null);
    try {
      await modulesApi.sync();
      await refresh();
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : 'Failed to sync module catalog');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleActivate = async (moduleEntry: AdminModule) => {
    const licenseKey = licenseInputs[moduleEntry.slug]?.trim() ?? '';
    if (!licenseKey) {
      return;
    }

    setActivatingSlug(moduleEntry.slug);
    setSyncError(null);
    setModuleNotice(null);
    try {
      const response = await modulesApi.activate(moduleEntry.slug, licenseKey);
      if (response.data) {
        updateModule(response.data);
        setLicenseInputs((current) => ({ ...current, [moduleEntry.slug]: '' }));
      }
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : 'Failed to activate module');
    } finally {
      setActivatingSlug(null);
    }
  };

  const handleInstallerAction = async (moduleEntry: AdminModule, action: ModuleInstallerAction, acknowledged = false) => {
    if (action === 'upgrade' && moduleEntry.installerUpgradeStrategy === 'maintenance' && !acknowledged) {
      setMaintenanceAcknowledged(false);
      setMaintenanceModule(moduleEntry);
      return;
    }
    setInstallerAction({ slug: moduleEntry.slug, action });
    setSyncError(null);
    setModuleNotice(null);
    try {
      const response = await modulesApi.installerAction(moduleEntry.slug, action, acknowledged);
      if (!response.data) {
        throw new Error('Installer did not return a job.');
      }
      let job = response.data;
      let hasPolled = false;
      setInstallerJobs((current) => ({ ...current, [moduleEntry.slug]: job }));
      while (job.status !== 'succeeded' && job.status !== 'failed') {
        if (hasPolled) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const pollResponse = await modulesApi.getInstallerJob(moduleEntry.slug, job.jobId);
        if (!pollResponse.data) {
          throw new Error('Installer job status is unavailable.');
        }
        job = pollResponse.data;
        hasPolled = true;
        setInstallerJobs((current) => ({ ...current, [moduleEntry.slug]: job }));
      }
      await refresh();
      try {
        await modulesApi.getInstallerStatus(moduleEntry.slug);
      } catch (statusError) {
        setSyncError(statusError instanceof ApiError
          ? `Module action completed, but installer status refresh failed: ${statusError.message}`
          : 'Module action completed, but installer status could not be refreshed.');
      }
      if (job.status === 'failed') {
        throw new Error(installerError(job) ?? `Failed to ${action} module`);
      }
      setModuleNotice(`${moduleEntry.displayName}: ${action} completed successfully.`);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : `Failed to ${action} module`);
    } finally {
      setInstallerAction(null);
    }
  };

  const handleRefreshLicense = async (moduleEntry: AdminModule) => {
    setRefreshingLicenseSlug(moduleEntry.slug);
    setSyncError(null);
    try {
      const response = await modulesApi.refreshLicense(moduleEntry.slug);
      if (response.data) updateModule(response.data);
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : 'Failed to refresh license');
    } finally {
      setRefreshingLicenseSlug(null);
    }
  };

  return (
    <div className="space-y-6">
      <Modal isOpen={maintenanceModule !== null} onClose={() => setMaintenanceModule(null)} title="Maintenance upgrade">
        <div className="space-y-4">
          <p>
            {maintenanceModule?.displayName} will be unavailable while its original services are stopped and replacements are checked.
            Container rollback cannot undo database migrations. Verify a complete backup and migration compatibility before continuing.
          </p>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={maintenanceAcknowledged} onChange={event => setMaintenanceAcknowledged(event.target.checked)} />
            <span>I approve this maintenance downtime and have checked backup and migration requirements.</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMaintenanceModule(null)}>Cancel</Button>
            <Button disabled={!maintenanceAcknowledged} onClick={() => {
              if (!maintenanceModule || !maintenanceAcknowledged) return;
              const selected = maintenanceModule;
              setMaintenanceModule(null);
              void handleInstallerAction(selected, 'upgrade', true);
            }}>Start maintenance upgrade</Button>
          </div>
        </div>
      </Modal>
      <PageHeader
        icon={appIcons.modules}
        title="Modules"
        description="Robin Admin hosts installed modules here. Catalog data comes from Robin Sheriff, while installation and activation state are local to this deployment."
        actions={(
          <>
            <Button variant="secondary" onClick={() => void refresh()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {isAdmin && (
              <Button onClick={() => void handleSync()} isLoading={isSyncing}>
                <RefreshCw className="h-4 w-4" />
                Sync catalog
              </Button>
            )}
          </>
        )}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="card p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Modules</div>
          <div className="mt-2 text-3xl font-semibold">{summary.total}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Installed</div>
          <div className="mt-2 text-3xl font-semibold">{summary.installed}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Hostable</div>
          <div className="mt-2 text-3xl font-semibold">{summary.hostable}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Paid modules</div>
          <div className="mt-2 text-3xl font-semibold">{summary.paid}</div>
        </div>
      </div>

      {moduleNotice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300">
          {moduleNotice}
        </div>
      )}

      {(error || syncError) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {syncError ?? error}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner className="text-robin-orange" />
        </div>
      ) : modules.length === 0 ? (
        <div className="card p-8 text-center">
          <Package className="mx-auto h-10 w-10 text-gray-400" />
          <h2 className="mt-4 text-lg font-semibold">No modules synced yet</h2>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Installed modules appear here from local deployment metadata. Robin Sheriff is only needed for manual catalog refreshes and license activation.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4" data-testid="module-list">
          {modules.map((moduleEntry) => (
            <ModuleCard
              key={moduleEntry.slug}
              moduleEntry={moduleEntry}
              isAdmin={isAdmin}
              isActivating={activatingSlug === moduleEntry.slug}
              isRefreshingLicense={refreshingLicenseSlug === moduleEntry.slug}
              installerAction={installerAction?.slug === moduleEntry.slug ? installerAction.action : null}
              installerJob={installerJobs[moduleEntry.slug] ?? null}
              licenseKey={licenseInputs[moduleEntry.slug] ?? ''}
              onLicenseKeyChange={(value) => setLicenseInputs((current) => ({ ...current, [moduleEntry.slug]: value }))}
              onActivate={() => void handleActivate(moduleEntry)}
              onRefreshLicense={() => void handleRefreshLicense(moduleEntry)}
              onInstallerAction={(action) => void handleInstallerAction(moduleEntry, action)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
