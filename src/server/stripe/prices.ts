import "server-only";

import { stripeClient } from "~/server/stripe/client";

const lookupKeyPriceIdCache = new Map<string, string>();

export async function getStripePriceIdByLookupKey(lookupKey: string) {
  const cachedPriceId = lookupKeyPriceIdCache.get(lookupKey);
  if (cachedPriceId) {
    return cachedPriceId;
  }

  const prices = await stripeClient.prices.list({
    active: true,
    limit: 1,
    lookup_keys: [lookupKey],
  });

  const matchedPrice = prices.data[0];
  if (!matchedPrice) {
    throw new Error(`No Stripe price found for lookup key: ${lookupKey}`);
  }

  lookupKeyPriceIdCache.set(lookupKey, matchedPrice.id);
  return matchedPrice.id;
}
