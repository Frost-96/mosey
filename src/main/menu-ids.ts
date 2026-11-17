import type { PetSize } from "../shared/size.ts";

// Stable menu item identities. Labels are presentation and may change freely;
// tests, tools and menu lookups address items only through these ids.
export const menuIds = {
  application: "mosey",
  retryPet: "retry-pet",
  hidePet: "hide-pet",
  showPet: "show-pet",
  size: "pet-size",
  settings: "open-settings",
  dockAttention: "dock-attention",
  dockSection: "dock-interaction",
  dockStatus: "dock-runtime-status",
  dockRetry: "dock-retry",
  dockValidation: "dock-validation",
  dockValidationStart: "dock-validation-start",
  dockValidationStop: "dock-validation-stop",
  dockValidationStatus: "dock-validation-status",
  dockValidationOrientation: "dock-validation-orientation",
  dailyActions: "daily-actions",
  quit: "quit",
} as const;

export const sizeMenuId = (size: PetSize) => `pet-size-${size}`;
