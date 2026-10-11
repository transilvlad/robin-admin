import type { DashboardTemplate } from '../types.js';

const S = 'host=~"$host",container=~"$container"';

export const dockerDashboard: DashboardTemplate = {
  key: 'docker',
  title: 'Docker containers',
  description: 'Docker stats contract: docker_* metrics with host and container labels.',
  variables: [
    { name: 'host', label: 'Host', source: 'host', match: 'docker_cpu_percent' },
    { name: 'container', label: 'Container', source: 'container', match: 'docker_cpu_percent{host=~"$host"}', multi: true },
  ],
  rows: [
    {
      title: 'Containers',
      panels: [
        {
          id: 'container-cpu',
          title: 'CPU',
          type: 'timeseries',
          unit: 'percent',
          min: 0,
          queries: [{ expr: `max by (container) (docker_cpu_percent{${S}})`, legend: '{{container}}' }],
        },
        {
          id: 'container-memory',
          title: 'Memory used',
          type: 'timeseries',
          unit: 'bytes',
          min: 0,
          queries: [{ expr: `max by (container) (docker_mem_used_bytes{${S}})`, legend: '{{container}}' }],
        },
        {
          id: 'container-memory-limit',
          title: 'Memory of limit',
          type: 'table',
          unit: 'percent',
          thresholds: { warning: 80, critical: 95 },
          queries: [{ expr: `max by (container) (docker_mem_percent{${S}})`, legend: '{{container}}' }],
        },
        {
          id: 'container-pids',
          title: 'Processes',
          type: 'timeseries',
          unit: 'count',
          min: 0,
          queries: [{ expr: `max by (container) (docker_pids{${S}})`, legend: '{{container}}' }],
        },
        {
          id: 'container-network',
          title: 'Network',
          type: 'timeseries',
          unit: 'bytes_per_second',
          min: 0,
          queries: [
            { expr: `sum by (container) (rate(docker_net_io_input_bytes{${S}}[$__rate_interval]))`, legend: '{{container}} in' },
            { expr: `sum by (container) (rate(docker_net_io_output_bytes{${S}}[$__rate_interval]))`, legend: '{{container}} out' },
          ],
        },
        {
          id: 'container-block-io',
          title: 'Block IO',
          type: 'timeseries',
          unit: 'bytes_per_second',
          min: 0,
          queries: [
            { expr: `sum by (container) (rate(docker_block_io_read_bytes{${S}}[$__rate_interval]))`, legend: '{{container}} read' },
            { expr: `sum by (container) (rate(docker_block_io_write_bytes{${S}}[$__rate_interval]))`, legend: '{{container}} write' },
          ],
        },
      ],
    },
  ],
};
