/**
 * Service selector dropdown for fleet management.
 *
 * Displays the currently selected Robin service and allows switching.
 * Shows service health status with color indicator.
 */

import { useState } from 'react';
import { ChevronDown, Server, Check, Circle } from 'lucide-react';
import { useServices } from '../../context/ServiceContext';
import { fleetServicesApi } from '../../api/client';

export function ServiceSelector() {
  const { selectedRobinService, robinServices, setSelectedRobinService, isLoading } = useServices();
  const [isOpen, setIsOpen] = useState(false);
  const [healthStatus, setHealthStatus] = useState<Record<string, boolean>>({});

  const enabledServices = robinServices.filter(i => i.enabled);

  const checkHealth = async (serviceId: string) => {
    try {
      const response = await fleetServicesApi.health(serviceId);
      setHealthStatus(prev => ({
        ...prev,
        [serviceId]: response.data?.healthy ?? false,
      }));
    } catch {
      setHealthStatus(prev => ({ ...prev, [serviceId]: false }));
    }
  };

  const handleOpen = () => {
    setIsOpen(true);
    // Check health for all services when dropdown opens
    enabledServices.forEach(inst => checkHealth(inst.serviceId));
  };

  if (isLoading) {
    return (
      <div className="px-3 py-2">
        <div className="h-9 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse" />
      </div>
    );
  }

  if (enabledServices.length <= 1) {
    // Single service - just show name without dropdown
    return (
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
          <Server className="w-4 h-4" />
          <span className="truncate">{selectedRobinService?.name || 'Default'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 relative">
      <button
        onClick={handleOpen}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm
                   bg-gray-100 dark:bg-gray-800 rounded-md
                   hover:bg-gray-200 dark:hover:bg-gray-700
                   text-gray-700 dark:text-gray-300 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Server className="w-4 h-4 shrink-0" />
          <span className="truncate">{selectedRobinService?.name || 'Select Service'}</span>
        </div>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div 
            className="fixed inset-0 z-10" 
            onClick={() => setIsOpen(false)} 
          />
          <div className="absolute left-3 right-3 top-full mt-1 z-20
                          bg-white dark:bg-gray-800 rounded-md shadow-lg border border-gray-200 dark:border-gray-700
                          max-h-64 overflow-y-auto">
            {enabledServices.map(inst => {
              const isSelected = inst.serviceId === selectedRobinService?.serviceId;
              const isHealthy = healthStatus[inst.serviceId];

              return (
                <button
                  key={inst.serviceId}
                  onClick={() => {
                    setSelectedRobinService(inst);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                              hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors
                              ${isSelected ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}
                >
                  <Circle 
                    className={`w-2 h-2 shrink-0 ${
                      isHealthy === undefined 
                        ? 'text-gray-400' 
                        : isHealthy 
                          ? 'text-green-500 fill-green-500' 
                          : 'text-red-500 fill-red-500'
                    }`} 
                  />
                  <span className="flex-1 truncate">{inst.name}</span>
                  {isSelected && <Check className="w-4 h-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
