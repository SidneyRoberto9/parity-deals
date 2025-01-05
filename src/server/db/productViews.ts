import { SQL, sql, gte, eq, desc, count, and } from 'drizzle-orm';
import { subDays, startOfDay } from 'date-fns';

import { tz } from '@date-fns/tz';
import {
    CACHE_TAGS, revalidateDbCache, getUserTag, getIdTag, getGlobalTag, dbCache
} from '@/lib/cache';
import { ProductViewTable, ProductTable, CountryTable, CountryGroupTable } from '@/drizzle/schema';
import { db } from '@/drizzle/db';

interface CreateProductViewProps {
  userId: string;
  countryId?: string;
  productId: string;
}

interface GetViewsByCountryChartDataProps {
  timezone: string;
  productId?: string;
  userId: string;
  interval: (typeof CHART_INTERVALS)[keyof typeof CHART_INTERVALS];
}

const getViewsByPPPChartData = ({
  timezone,
  productId,
  userId,
  interval,
}: GetViewsByCountryChartDataProps) => {
  const cacheFn = dbCache(getViewsByPPPChartDataInternal, {
    tags: [
      getUserTag(userId, CACHE_TAGS.productViews),
      productId == null
        ? getUserTag(userId, CACHE_TAGS.products)
        : getIdTag(productId, CACHE_TAGS.products),
      getGlobalTag(CACHE_TAGS.countries),
      getGlobalTag(CACHE_TAGS.countryGroups),
    ],
  });

  return cacheFn({
    timezone,
    productId,
    userId,
    interval,
  });
};

const getViewsByDayChartData = async ({
  timezone,
  productId,
  userId,
  interval,
}: GetViewsByCountryChartDataProps) => {
  const cacheFn = dbCache(getViewsByDayChartDataInternal, {
    tags: [
      getUserTag(userId, CACHE_TAGS.productViews),
      productId == null
        ? getUserTag(userId, CACHE_TAGS.products)
        : getIdTag(productId, CACHE_TAGS.products),
    ],
  });

  return cacheFn({
    timezone,
    productId,
    userId,
    interval,
  });
};

const getViewsByCountryChartData = async ({
  timezone,
  productId,
  userId,
  interval,
}: GetViewsByCountryChartDataProps) => {
  const cacheFn = dbCache(getViewsByCountryChartDataInternal, {
    tags: [
      getUserTag(userId, CACHE_TAGS.productViews),
      productId == null
        ? getUserTag(userId, CACHE_TAGS.products)
        : getIdTag(productId, CACHE_TAGS.products),
      getGlobalTag(CACHE_TAGS.countries),
    ],
  });

  return cacheFn({
    timezone,
    productId,
    userId,
    interval,
  });
};

const getProductViewCount = async (userId: string, startDate: Date) => {
  const cacheFn = dbCache(getProductViewCountInternal, {
    tags: [getUserTag(userId, CACHE_TAGS.productViews)],
  });

  return cacheFn(userId, startDate);
};

const createProductView = async ({ userId, countryId, productId }: CreateProductViewProps) => {
  const [newRow] = await db
    .insert(ProductViewTable)
    .values({ productId, countryId, visitedAt: new Date() })
    .returning({
      id: ProductViewTable.id,
    });

  if (newRow != null) {
    revalidateDbCache({
      tag: CACHE_TAGS.productViews,
      userId,
      id: productId,
    });
  }
};

const getProductViewCountInternal = async (userId: string, startDate: Date) => {
  const counts = await db
    .select({ pricingViewCount: count() })
    .from(ProductViewTable)
    .innerJoin(ProductTable, eq(ProductTable.id, ProductViewTable.productId))
    .where(and(eq(ProductTable.clerkUserId, userId), gte(ProductViewTable.visitedAt, startDate)));

  return counts[0]?.pricingViewCount ?? 0;
};

const getViewsByCountryChartDataInternal = async ({
  timezone,
  productId,
  userId,
  interval,
}: GetViewsByCountryChartDataProps) => {
  const startDate = startOfDay(interval.startDate, { in: tz(timezone) });
  const productsSq = getProductSubQuery(userId, productId);
  return await db
    .with(productsSq)
    .select({
      views: count(ProductViewTable.visitedAt),
      countryName: CountryTable.name,
      countryCode: CountryTable.code,
    })
    .from(ProductViewTable)
    .innerJoin(productsSq, eq(productsSq.id, ProductViewTable.productId))
    .innerJoin(CountryTable, eq(CountryTable.id, ProductViewTable.countryId))
    .where(
      gte(sql`${ProductViewTable.visitedAt} AT TIME ZONE ${timezone}`.inlineParams(), startDate),
    )
    .groupBy(({ countryCode, countryName }) => [countryCode, countryName])
    .orderBy(({ views }) => desc(views))
    .limit(25);
};

const getViewsByDayChartDataInternal = async ({
  timezone,
  productId,
  userId,
  interval,
}: GetViewsByCountryChartDataProps) => {
  const productsSq = getProductSubQuery(userId, productId);
  const productViewSq = db.$with('productViews').as(
    db
      .with(productsSq)
      .select({
        visitedAt: sql`${ProductViewTable.visitedAt} AT TIME ZONE ${timezone}`
          .inlineParams()
          .as('visitedAt'),
        productId: productsSq.id,
      })
      .from(ProductViewTable)
      .innerJoin(productsSq, eq(productsSq.id, ProductViewTable.productId)),
  );

  return await db
    .with(productViewSq)
    .select({
      date: interval
        .dateGrouper(sql.raw('series'))
        .mapWith((dateString) => interval.dateFormatter(new Date(dateString))),
      views: count(productViewSq.visitedAt),
    })
    .from(interval.sql)
    .leftJoin(productViewSq, ({ date }) => eq(interval.dateGrouper(productViewSq.visitedAt), date))
    .groupBy(({ date }) => [date])
    .orderBy(({ date }) => date);
};

const getViewsByPPPChartDataInternal = async ({
  timezone,
  productId,
  userId,
  interval,
}: GetViewsByCountryChartDataProps) => {
  const startDate = startOfDay(interval.startDate, { in: tz(timezone) });
  const productsSq = getProductSubQuery(userId, productId);
  const productViewSq = db.$with('productViews').as(
    db
      .with(productsSq)
      .select({
        visitedAt: sql`${ProductViewTable.visitedAt} AT TIME ZONE ${timezone}`
          .inlineParams()
          .as('visitedAt'),
        countryGroupId: CountryTable.countryGroupId,
      })
      .from(ProductViewTable)
      .innerJoin(productsSq, eq(productsSq.id, ProductViewTable.productId))
      .innerJoin(CountryTable, eq(CountryTable.id, ProductViewTable.countryId))
      .where(({ visitedAt }) => gte(visitedAt, startDate)),
  );

  return await db
    .with(productViewSq)
    .select({
      pppName: CountryGroupTable.name,
      views: count(productViewSq.visitedAt),
    })
    .from(CountryGroupTable)
    .leftJoin(productViewSq, eq(productViewSq.countryGroupId, CountryGroupTable.id))
    .groupBy(({ pppName }) => [pppName])
    .orderBy(({ pppName }) => pppName);
};

const getProductSubQuery = (userId: string, productId: string | undefined) => {
  return db.$with('products').as(
    db
      .select()
      .from(ProductTable)
      .where(
        and(
          eq(ProductTable.clerkUserId, userId),
          productId == null ? undefined : eq(ProductTable.id, productId),
        ),
      ),
  );
};

const CHART_INTERVALS = {
  last7Days: {
    dateFormatter: (date: Date) => dateFormatter.format(date),
    startDate: subDays(new Date(), 7),
    label: 'Last 7 Days',
    sql: sql`GENERATE_SERIES(current_date - 7, current_date, '1 day'::interval) as series`,
    dateGrouper: (col: SQL | SQL.Aliased) => sql<string>`DATE(${col})`.inlineParams(),
  },
  last30Days: {
    dateFormatter: (date: Date) => dateFormatter.format(date),
    startDate: subDays(new Date(), 30),
    label: 'Last 30 Days',
    sql: sql`GENERATE_SERIES(current_date - 30, current_date, '1 day'::interval) as series`,
    dateGrouper: (col: SQL | SQL.Aliased) => sql<string>`DATE(${col})`.inlineParams(),
  },
  last365Days: {
    dateFormatter: (date: Date) => monthFormatter.format(date),
    startDate: subDays(new Date(), 365),
    label: 'Last 365 Days',
    sql: sql`GENERATE_SERIES(DATE_TRUNC('month', current_date - 365), DATE_TRUNC('month', current_date), '1 month'::interval) as series`,
    dateGrouper: (col: SQL | SQL.Aliased) =>
      sql<string>`DATE_TRUNC('month', ${col})`.inlineParams(),
  },
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeZone: 'UTC',
});

const monthFormatter = new Intl.DateTimeFormat(undefined, {
  year: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});

export {
  CHART_INTERVALS,
  createProductView,
  getProductViewCount,
  getViewsByCountryChartData,
  getViewsByDayChartData,
  getViewsByPPPChartData,
};
