import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  AtSign,
  BarChart3,
  Bell,
  BookOpen,
  ChartLine,
  Compass,
  RadioTower,
  Brain,
  Cylinder,
  Database,
  DatabaseZap,
  FlaskConical,
  FileBarChart,
  FileCode,
  FileText,
  Gauge,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Lock,
  Mail,
  Package,
  Repeat,
  Puzzle,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  User,
  Users,
  Server,
  ServerCog,
  ShieldAlert,
  Wrench,
  Zap,
} from 'lucide-react';

export const appIcons = {
  dashboard: LayoutDashboard,
  users: Users,
  aliases: AtSign,
  autoAliases: Repeat,
  queue: Mail,
  metrics: Activity,
  robinConfig: FileCode,
  rspamd: ShieldAlert,
  rspamdConfig: FileCode,
  rspamdRules: Wrench,
  rspamdDkim: Shield,
  rspamdTraining: Brain,
  rspamdScan: Search,
  rspamdMetrics: Activity,
  clamav: Shield,
  clamavConfig: FileCode,
  clamavMetrics: Activity,
  clamavScan: Search,
  dovecot: Inbox,
  dovecotConfig: FileCode,
  dovecotMetrics: Activity,
  postfix: Mail,
  postfixConfig: FileCode,
  postfixMetrics: Activity,
  postfixQueue: Mail,
  redis: Zap,
  redisConfig: FileCode,
  redisMetrics: Activity,
  postgres: Cylinder,
  postgresConfig: FileCode,
  postgresMetrics: Activity,
  mariadb: DatabaseZap,
  mariadbConfig: FileCode,
  mariadbMetrics: Activity,
  logs: ScrollText,
  sheriff: ShieldCheck,
  sheriffLicenses: KeyRound,
  sheriffStatus: Gauge,
  fleetInstances: Server,
  fleetMetrics: Activity,
  fleetAgents: ServerCog,
  fleetDocs: BookOpen,
  reportingOverview: BarChart3,
  reportingIssues: AlertTriangle,
  domainPosture: Gauge,
  senderCatalog: ShieldCheck,
  tlsPosture: Lock,
  forensicIncidents: AlertTriangle,
  dmarcRaw: FileBarChart,
  tlsrptRaw: Lock,
  forensicRaw: AlertTriangle,
  administration: Settings,
  access: Shield,
  security: Lock,
  ingestion: FileBarChart,
  integration: Database,
  reporting: BarChart3,
  admins: Shield,
  auditLog: FileText,
  config: Settings,
  deliveryTest: Send,
  sendEmail: Send,
  profile: User,
  modules: Puzzle,
  module: Package,
  alerts: AlertTriangle,
  notifications: Bell,
  email: Mail,
  monitoring: Activity,
  statusPage: FileText,
  telemetry: ChartLine,
  telemetryExplore: Compass,
  telemetrySources: RadioTower,
} satisfies Record<string, LucideIcon>;

interface ModuleIconSource {
  slug?: string;
  iconName?: string | null;
}

const namedModuleIcons: Record<string, LucideIcon> = {
  package: Package,
  puzzle: Puzzle,
  qa: FlaskConical,
  flask: FlaskConical,
  detective: Search,
  search: Search,
  overview: LayoutDashboard,
  issues: AlertTriangle,
  environments: Server,
  cases: FileText,
  runs: Activity,
  'shield-check': ShieldCheck,
  shield: Shield,
  mail: Mail,
  envelope: Mail,
  settings: Settings,
  'file-code': FileCode,
};

export function resolveModuleIcon(module?: ModuleIconSource | null): LucideIcon {
  const iconName = module?.iconName?.trim().toLowerCase();
  if (iconName && namedModuleIcons[iconName]) {
    return namedModuleIcons[iconName];
  }

  switch (module?.slug) {
    case 'robin-qa':
      return Search;
    case 'robin-sheriff':
      return ShieldCheck;
    case 'robin-tools':
      return Wrench;
    default:
      return Package;
  }
}

export function resolveModuleNavigationIcon(module: ModuleIconSource | null | undefined, iconName?: string | null): LucideIcon {
  const namedIcon = iconName ? namedModuleIcons[iconName.trim().toLowerCase()] : null;
  return namedIcon ?? resolveModuleIcon(module);
}
