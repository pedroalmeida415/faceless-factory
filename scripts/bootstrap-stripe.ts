import {
  BILLING_CURRENCY,
  BILLING_PLANS,
} from "~/features/billing/domain/billing";
import { stripeClient } from "~/features/billing/infra/stripe";

async function ensureProduct(planName: string, title: string) {
  const products = await stripeClient.products.list({
    active: true,
    limit: 100,
  });
  const existingProduct = products.data.find(
    (product) =>
      product.metadata.app === "faceless-factory" &&
      product.metadata.plan === planName,
  );

  if (existingProduct) {
    return existingProduct;
  }

  return stripeClient.products.create({
    metadata: {
      app: "faceless-factory",
      plan: planName,
    },
    name: `Faceless Factory ${title}`,
  });
}

async function ensureRecurringPrice(params: {
  interval: "month" | "year";
  lookupKey: string;
  productId: string;
  unitAmount: number;
}) {
  const existingPrices = await stripeClient.prices.list({
    active: true,
    limit: 1,
    lookup_keys: [params.lookupKey],
  });

  if (existingPrices.data[0]) {
    return existingPrices.data[0];
  }

  return stripeClient.prices.create({
    currency: BILLING_CURRENCY,
    lookup_key: params.lookupKey,
    product: params.productId,
    recurring: {
      interval: params.interval,
    },
    unit_amount: params.unitAmount,
  });
}

async function main() {
  for (const plan of BILLING_PLANS) {
    const product = await ensureProduct(plan.name, plan.title);
    const monthlyPrice = await ensureRecurringPrice({
      interval: "month",
      lookupKey: plan.monthlyPriceLookupKey,
      productId: product.id,
      unitAmount: plan.monthlyPriceCents,
    });
    const annualPrice = await ensureRecurringPrice({
      interval: "year",
      lookupKey: plan.annualPriceLookupKey,
      productId: product.id,
      unitAmount: plan.annualPriceCents,
    });

    console.log(
      [
        `${plan.title}:`,
        `product=${product.id}`,
        `monthly=${monthlyPrice.id}`,
        `annual=${annualPrice.id}`,
      ].join(" "),
    );
  }
}

void main();
