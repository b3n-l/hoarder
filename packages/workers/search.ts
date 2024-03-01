import { db } from "@hoarder/db";
import logger from "@hoarder/shared/logger";
import { getSearchIdxClient } from "@hoarder/shared/search";
import {
  SearchIndexingQueue,
  ZSearchIndexingRequest,
  queueConnectionDetails,
  zSearchIndexingRequestSchema,
} from "@hoarder/shared/queues";
import { Job } from "bullmq";
import { Worker } from "bullmq";
import { bookmarks } from "@hoarder/db/schema";
import { eq } from "drizzle-orm";

export class SearchIndexingWorker {
  static async build() {
    logger.info("Starting search indexing worker ...");
    const worker = new Worker<ZSearchIndexingRequest, void>(
      SearchIndexingQueue.name,
      runSearchIndexing,
      {
        connection: queueConnectionDetails,
        autorun: false,
      },
    );

    worker.on("completed", (job) => {
      const jobId = job?.id || "unknown";
      logger.info(`[search][${jobId}] Completed successfully`);
    });

    worker.on("failed", (job, error) => {
      const jobId = job?.id || "unknown";
      logger.error(`[search][${jobId}] openai job failed: ${error}`);
    });

    return worker;
  }
}

async function runIndex(
  searchClient: NonNullable<Awaited<ReturnType<typeof getSearchIdxClient>>>,
  bookmarkId: string,
) {
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    with: {
      link: true,
      text: true,
      tagsOnBookmarks: {
        with: {
          tag: true,
        },
      },
    },
  });

  if (!bookmark) {
    throw new Error(`Bookmark ${bookmarkId} not found`);
  }

  searchClient.addDocuments([
    {
      id: bookmark.id,
      userId: bookmark.userId,
      ...(bookmark.link
        ? {
            url: bookmark.link.url,
            title: bookmark.link.title,
            description: bookmark.link.description,
          }
        : undefined),
      ...(bookmark.text ? { content: bookmark.text.text } : undefined),
      tags: bookmark.tagsOnBookmarks.map((t) => t.tag.name),
    },
  ]);
}

async function runDelete(
  searchClient: NonNullable<Awaited<ReturnType<typeof getSearchIdxClient>>>,
  bookmarkId: string,
) {
  await searchClient.deleteDocument(bookmarkId);
}

async function runSearchIndexing(job: Job<ZSearchIndexingRequest, void>) {
  const jobId = job.id || "unknown";

  const request = zSearchIndexingRequestSchema.safeParse(job.data);
  if (!request.success) {
    throw new Error(
      `[search][${jobId}] Got malformed job request: ${request.error.toString()}`,
    );
  }

  const searchClient = await getSearchIdxClient();
  if (!searchClient) {
    logger.debug(
      `[search][${jobId}] Search is not configured, nothing to do now`,
    );
    return;
  }

  const bookmarkId = request.data.bookmarkId;
  switch (request.data.type) {
    case "index": {
      await runIndex(searchClient, bookmarkId);
      break;
    }
    case "delete": {
      await runDelete(searchClient, bookmarkId);
      break;
    }
  }
}