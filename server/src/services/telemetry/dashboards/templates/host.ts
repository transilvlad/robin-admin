import { IGNORED_DISKS, IGNORED_FILESYSTEMS, IGNORED_INTERFACES, type DashboardTemplate } from '../types.js';

const H = 'host=~"$host"';

export const hostDashboard: DashboardTemplate = {
  key: 'host',
  title: 'Linux host',
  description: 'Vector host_metrics contract: host_* metrics with host and role labels.',
  variables: [
    { name: 'role', label: 'Role', source: 'role', match: 'host_uptime', multi: true },
    { name: 'host', label: 'Host', source: 'host', match: 'host_uptime{role=~"$role"}' },
  ],
  rows: [
    {
      title: 'Overview',
      panels: [
        {
          id: 'cpu-busy',
          title: 'CPU busy',
          type: 'stat',
          unit: 'percent',
          width: 1,
          thresholds: { warning: 70, critical: 90 },
          queries: [{ expr: `100 * (1 - avg(rate(host_cpu_seconds_total{${H},mode="idle"}[$__rate_interval])))` }],
        },
        {
          id: 'memory-used',
          title: 'Memory used',
          type: 'stat',
          unit: 'percent',
          width: 1,
          thresholds: { warning: 85, critical: 95 },
          queries: [{ expr: `100 * sum(host_memory_used_bytes{${H}}) / sum(host_memory_total_bytes{${H}})` }],
        },
        {
          id: 'root-disk',
          title: 'Root filesystem used',
          type: 'stat',
          unit: 'percent',
          width: 1,
          thresholds: { warning: 80, critical: 90 },
          queries: [{ expr: `100 * max(host_filesystem_used_ratio{${H},mountpoint="/"})` }],
        },
        {
          id: 'load-per-cpu',
          title: 'Load per CPU (15m)',
          description: 'Above 1 means more runnable work than CPUs.',
          type: 'stat',
          unit: 'none',
          width: 1,
          thresholds: { warning: 1, critical: 2 },
          queries: [{ expr: `sum(host_load15{${H}}) / sum(host_logical_cpus{${H}})` }],
        },
      ],
    },
    {
      title: 'CPU and load',
      panels: [
        {
          id: 'cpu-modes',
          title: 'CPU by mode',
          type: 'timeseries',
          unit: 'percent',
          stacked: true,
          min: 0,
          queries: [{
            expr: `100 * sum by (mode) (rate(host_cpu_seconds_total{${H},mode!="idle"}[$__rate_interval])) / scalar(count(host_cpu_seconds_total{${H},mode="idle"}))`,
            legend: '{{mode}}',
          }],
        },
        {
          id: 'load',
          title: 'Load average',
          type: 'timeseries',
          unit: 'none',
          min: 0,
          queries: [
            { expr: `sum(host_load1{${H}})`, legend: '1m' },
            { expr: `sum(host_load5{${H}})`, legend: '5m' },
            { expr: `sum(host_load15{${H}})`, legend: '15m' },
            { expr: `sum(host_logical_cpus{${H}})`, legend: 'CPUs' },
          ],
        },
      ],
    },
    {
      title: 'Memory',
      panels: [
        {
          id: 'memory',
          title: 'Memory',
          type: 'timeseries',
          unit: 'bytes',
          min: 0,
          queries: [
            { expr: `sum(host_memory_used_bytes{${H}})`, legend: 'Used' },
            { expr: `sum(host_memory_cached_bytes{${H}})`, legend: 'Cached' },
            { expr: `sum(host_memory_available_bytes{${H}})`, legend: 'Available' },
            { expr: `sum(host_memory_total_bytes{${H}})`, legend: 'Total' },
          ],
        },
        {
          id: 'swap',
          title: 'Swap',
          type: 'timeseries',
          unit: 'bytes',
          min: 0,
          queries: [
            { expr: `sum(host_memory_swap_used_bytes{${H}})`, legend: 'Used' },
            { expr: `sum(host_memory_swap_total_bytes{${H}})`, legend: 'Total' },
          ],
        },
      ],
    },
    {
      title: 'Storage',
      panels: [
        {
          id: 'filesystem-used',
          title: 'Filesystem used',
          type: 'timeseries',
          unit: 'percent',
          min: 0,
          max: 100,
          queries: [{
            expr: `100 * max by (mountpoint) (host_filesystem_used_ratio{${H},filesystem!~"${IGNORED_FILESYSTEMS}"})`,
            legend: '{{mountpoint}}',
          }],
        },
        {
          id: 'filesystem-free',
          title: 'Filesystem free',
          type: 'table',
          unit: 'bytes',
          thresholds: { warning: 10 * 1024 ** 3, critical: 2 * 1024 ** 3 },
          invertThresholds: true,
          queries: [{
            expr: `max by (mountpoint) (host_filesystem_free_bytes{${H},filesystem!~"${IGNORED_FILESYSTEMS}"})`,
            legend: '{{mountpoint}}',
          }],
        },
        {
          id: 'disk-throughput',
          title: 'Disk throughput',
          type: 'timeseries',
          unit: 'bytes_per_second',
          min: 0,
          queries: [
            { expr: `sum by (device) (rate(host_disk_read_bytes_total{${H},device!~"${IGNORED_DISKS}"}[$__rate_interval]))`, legend: '{{device}} read' },
            { expr: `sum by (device) (rate(host_disk_written_bytes_total{${H},device!~"${IGNORED_DISKS}"}[$__rate_interval]))`, legend: '{{device}} write' },
          ],
        },
        {
          id: 'disk-iops',
          title: 'Disk operations',
          type: 'timeseries',
          unit: 'per_second',
          min: 0,
          queries: [
            { expr: `sum by (device) (rate(host_disk_reads_completed_total{${H},device!~"${IGNORED_DISKS}"}[$__rate_interval]))`, legend: '{{device}} reads' },
            { expr: `sum by (device) (rate(host_disk_writes_completed_total{${H},device!~"${IGNORED_DISKS}"}[$__rate_interval]))`, legend: '{{device}} writes' },
          ],
        },
      ],
    },
    {
      title: 'Network',
      panels: [
        {
          id: 'network-throughput',
          title: 'Network throughput',
          type: 'timeseries',
          unit: 'bits_per_second',
          min: 0,
          queries: [
            { expr: `8 * sum by (device) (rate(host_network_receive_bytes_total{${H},device!~"${IGNORED_INTERFACES}"}[$__rate_interval]))`, legend: '{{device}} in' },
            { expr: `8 * sum by (device) (rate(host_network_transmit_bytes_total{${H},device!~"${IGNORED_INTERFACES}"}[$__rate_interval]))`, legend: '{{device}} out' },
          ],
        },
        {
          id: 'network-errors',
          title: 'Network errors',
          type: 'timeseries',
          unit: 'per_second',
          min: 0,
          queries: [
            { expr: `sum by (device) (rate(host_network_receive_errs_total{${H},device!~"${IGNORED_INTERFACES}"}[$__rate_interval]))`, legend: '{{device}} receive errors' },
            { expr: `sum by (device) (rate(host_network_transmit_errs_total{${H},device!~"${IGNORED_INTERFACES}"}[$__rate_interval]))`, legend: '{{device}} transmit errors' },
          ],
        },
      ],
    },
  ],
};
