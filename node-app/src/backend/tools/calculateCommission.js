/** Commission tool dispatcher — picks the EGY or UAE implementation per country. */

import { createCalculateCommissionEGY } from "./calculateCommissionEGY.js";
import { createCalculateCommissionUAE } from "./calculateCommissionUAE.js";

export { createCalculateCommissionEGY } from "./calculateCommissionEGY.js";
export { createCalculateCommissionUAE } from "./calculateCommissionUAE.js";

export function createCalculateCommission(countryId) {
  return Number(countryId) === 7
    ? createCalculateCommissionUAE()
    : createCalculateCommissionEGY();
}

export const calculateCommission = createCalculateCommissionEGY();
