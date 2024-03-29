//import { Logger } from '@aws-lambda-powertools/logger';
//import { Metrics } from '@aws-lambda-powertools/metrics';
//import { Tracer } from '@aws-lambda-powertools/tracer';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { Handler } from 'aws-lambda';
import { Promise } from 'bluebird';
import markdown from 'markdown-doc-builder';
import Parser from 'rss-parser';
import { CreateThumbnailInputPayload } from '../create-thumbnail';
import { source } from './config';

const bucketName = process.env.BUCKET_NAME!;
const hugoContentPath = process.env.HUGO_CONTENT_PATH!;

//const logger = new Logger();
//const metrics = new Metrics();
//const tracer = new Tracer();

const s3 = new S3Client({});

/** S3 Object のメタデータを取得する */
const getMetadata = async (bucket: string, key: string, metadataKey: string): Promise<string|undefined> => {
  const cmd = new HeadObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  try {
    const { Metadata } = await s3.send(cmd);
    const val = Metadata?.[metadataKey];
    return val;
  } catch (error) {
    return undefined;
  }
};

/** Amazon Translate による翻訳 */
const translate = async (text: string, sourceLanguageCode: string, targetLanguageCode: string) => {
  const client = new TranslateClient({});
  const cmd = new TranslateTextCommand({
    Text: text,
    SourceLanguageCode: sourceLanguageCode,
    TargetLanguageCode: targetLanguageCode,
  });
  const { TranslatedText } = await client.send(cmd);
  return TranslatedText || text;
};

/** RSS Feed から指定範囲の記事を取得する */
const getFeed = async (feedUrl: string, oldestPubDate: Date, latestPubDate: Date) => {
  const parser = new Parser();
  try {
    const feed = await parser.parseURL(feedUrl);
    feed.items = feed.items.filter((item) => {
      const pubDate = new Date(item.pubDate!);
      return (pubDate > oldestPubDate && pubDate <= latestPubDate);
    });
    return feed;
  } catch (err) {
    console.error(err);
    const feed = { title: 'error', items: [] };
    return feed;
  }

};

/** Step Functions から呼び出される際の input */
interface Event {
  lang: string;
  time: string;
  isDraft: boolean;
};

interface contentData {
  announcements: ({[key: string]: any} & Parser.Item)[];
  youtube: {
    title: string;
    //link: string;
    items: ({[key: string]: any} & Parser.Item)[];
  }[];
  blogs: {
    title: string;
    //link: string;
    items: ({[key: string]: any} & Parser.Item)[];
  }[];
  oss: {
    title: string;
    link: string;
    items: ({[key: string]: any} & Parser.Item)[];
  }[];
}

export const handler: Handler = async (event: Event, _context) => {
  const { time, isDraft, lang } = event;

  const executedDate = new Date(time);

  const latestPubDate = new Date(executedDate);
  if (latestPubDate.getHours() != 0 || latestPubDate.getMinutes() != 0) {
    latestPubDate.setHours(0, 0, 0, 0);
    latestPubDate.setDate(latestPubDate.getDate() + 1);
  }
  const oldestPubDate = new Date(latestPubDate);
  oldestPubDate.setDate(oldestPubDate.getDate() - 1);

  switch (latestPubDate.getDay()) {
    case 6:
      latestPubDate.setDate(latestPubDate.getDate() + 2);
      break;
    case 0:
      latestPubDate.setDate(latestPubDate.getDate() + 1);
      oldestPubDate.setDate(oldestPubDate.getDate() - 1);
      break;
    case 1:
      oldestPubDate.setDate(oldestPubDate.getDate() - 2);
      break;
    default:
      break;
  };

  const pubDateRange = (lang == 'ja')
    ? `${oldestPubDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ~ ${latestPubDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} (JST)`
    : `${oldestPubDate.toLocaleString('en-US', { timeZone: 'UCT' })} ~ ${latestPubDate.toLocaleString('en-US', { timeZone: 'UTC' })} (UTC)`;

  const articleTitle = oldestPubDate.toISOString().split('T')[0];
  const articleDescription = (lang == 'ja')
    ? 'AWS関連のニュースヘッドライン'
    : 'AWS News Headlines';
  const urlPath = `headlines/${articleTitle.replace(/-/g, '')}`;
  const objectKey = `${hugoContentPath}/${urlPath}/index.${lang}.md`;

  // https://gohugo.io/content-management/front-matter/
  const frontMatter = {
    draft: isDraft,
    isCJKLanguage: (lang == 'ja') ? true : false,
    title: articleTitle,
    description: articleDescription,
    date: await getMetadata(bucketName, objectKey, 'date') || executedDate.toISOString(),
    lastmod: executedDate.toISOString(),
    categories: ['news'],
    series: ['daily-aws'],
    tags: [] as string[],
  };

  const data: contentData = {
    announcements: [],
    youtube: [],
    blogs: [],
    oss: [],
  };

  /** AWS のアップデート情報 */
  await (async() => {
    const feedUrl = 'https://aws.amazon.com/new/feed/';
    const { items } = await getFeed(feedUrl, oldestPubDate, latestPubDate);
    if (lang != 'en') {
      await Promise.map(
        items,
        async (item) => {
          item.contentSnippet = await translate(item.contentSnippet!, 'en', lang);
        },
        { concurrency: 5 },
      );
    }
    items.map((item) => {
      const categories = item.categories?.flatMap(x => x.split(',')) || [];
      const products = categories?.filter(x => x.startsWith('general:products/')).map(x => x.replace('general:products/', ''));
      frontMatter.tags.push(...products);
    });
    data.announcements.push(...items);
  })();

  //for await (let channel of source.youtube.channels) {
  //  const channelTitle = (lang == 'ja') ? channel.title.ja : channel.title.en;
  //  //const channelUrl = `https://www.youtube.com/channel/${channel.id}`;
  //  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  //  const { items } = await getFeed(feedUrl, oldestPubDate, latestPubDate);
  //  if (lang != 'ja') {
  //    await Promise.map(items, async (item) => { item.title = await translate(item.title!, 'ja', lang); }, { concurrency: 5 });
  //  }
  //  if (items.length > 0) {
  //    data.youtube.push({ title: `${channelTitle}`, items });
  //  }
  //};

  /** YouTube のプレイリスト */
  for await (let playlist of source.youtube.playlists) {
    const playlistTitle = (lang == 'ja') ? playlist.title.ja : playlist.title.en;
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlist.id}`;
    const { items } = await getFeed(feedUrl, oldestPubDate, latestPubDate);
    if (items.length > 0) {
      if (lang != 'ja') {
        await Promise.map(items, async (item) => { item.title = await translate(item.title!, 'ja', lang); }, { concurrency: 5 });
      }
      data.youtube.push({ title: `${playlistTitle}`, items });
    }
  };

  /** AWS Japan Blogs */
  for await (let blog of source.awsJapanBlogs) {
    const blogTitle = (lang == 'ja') ? blog.title.ja : blog.title.en;
    const feedUrl = `https://aws.amazon.com/jp/blogs/${blog.category}/feed/`;
    const { items } = await getFeed(feedUrl, oldestPubDate, latestPubDate);
    if (items.length > 0) {
      if (lang != 'ja') {
        await Promise.map(items, async (item) => { item.title = await translate(item.title!, 'ja', lang); }, { concurrency: 5 });
      }
      data.blogs.push({ title: `${blogTitle}`, items });
    }
  };

  /** AWS Blogs */
  for await (let blog of source.awsBlogs) {
    const feedUrl = `https://aws.amazon.com/blogs/${blog.category}/feed/`;
    const { title: blogTitle, items } = await getFeed(feedUrl, oldestPubDate, latestPubDate);
    if (items.length > 0) {
      if (lang != 'en') {
        await Promise.map(items, async (item) => { item.title = await translate(item.title!, 'en', lang); }, { concurrency: 5 });
      }
      data.blogs.push({ title: `${blogTitle}`, items });
    }
  };

  /** OSS Projects */
  for await (let repo of source.githubRepos) {
    const repoUrl = `https://github.com/${repo.name}/`;
    const feedUrl = `https://github.com/${repo.name}/releases.atom`;
    const { items } = await getFeed(feedUrl, oldestPubDate, latestPubDate);
    //items = items.filter(item => !item.title?.includes('unstable'));
    if (items.length > 0) {
      data.oss.push({ title: repo.title, link: repoUrl, items });
    }
  };

  frontMatter.tags = Array.from(new Set(frontMatter.tags));

  const mdBody = markdown.newBuilder()
    .headerOrdered(false)
    .text(JSON.stringify(frontMatter))
    .newline();

  mdBody.text(pubDateRange).newline();

  const announcementsHeader = (lang == 'ja') ? '最近の発表' : 'Recent Announcements';
  mdBody.h3(announcementsHeader);
  if (data.announcements.length > 0) {
    for await (let item of data.announcements) {
      mdBody.bold(`[${item.title}](${item.link})`).newline();
      mdBody.blockQuote(`${item.contentSnippet}`);
    }
  } else {
    mdBody.text('No updates.').newline();
  }

  if (data.youtube.length > 0) {
    mdBody.h3('YouTube');
    for await (let channel of data.youtube) {
      mdBody.h4(channel.title);
      for await (let item of channel.items) {
        mdBody.text(`- [${item.title}](${item.link})`).newline();
      }
    }
  }

  if (data.blogs.length > 0) {
    mdBody.h3('AWS Blogs');
    for await (let blog of data.blogs) {
      mdBody.h4(blog.title).newline();
      for await (let item of blog.items) {
        mdBody.text(`- [${item.title}](${item.link})`).newline();
      }
    }
  }

  if (data.oss.length > 0) {
    mdBody.h3('Open Source Project');
    for await (let repo of data.oss) {
      mdBody.h4(repo.title);
      for await (let item of repo.items) {
        mdBody.text(`- [${item.title}](${item.link})`).newline();
      }
    }
  }

  const putObjectCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: mdBody.toMarkdown(),
    ContentType: 'text/markdown; charset=UTF-8',
    Metadata: {
      draft: (frontMatter.draft) ? 'true' : 'false',
      date: frontMatter.date,
      lastmod: frontMatter.lastmod,
      categories: frontMatter.categories.toString(),
      series: frontMatter.series.toString(),
      tags: frontMatter.tags.toString(),
    },
  });
  await s3.send(putObjectCommand);

  const payload: CreateThumbnailInputPayload = {
    lang,
    title: articleTitle,
    description: articleDescription,
    pubDateRange,
    urlPath: urlPath,
  };

  return payload;
};
