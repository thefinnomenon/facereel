import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const campaign = JSON.parse(
  await readFile(new URL("../marketing/campaign.json", import.meta.url), "utf8"),
) as {
  creators: Array<{ username: string; instagramUserId?: string }>;
};

const runner = await readFile(
  new URL("../scripts/run-campaign.ts", import.meta.url),
  "utf8",
);

test("campaign contains 1,000 unique valid creator usernames", () => {
  assert.equal(campaign.creators.length, 1_000);
  const usernames = new Set<string>();
  for (const creator of campaign.creators) {
    assert.match(creator.username, /^[A-Za-z0-9._]+$/);
    usernames.add(creator.username.toLowerCase());
  }
  assert.equal(usernames.size, campaign.creators.length);
  assert.match(campaign.creators[0]?.instagramUserId ?? "", /^\d+$/);
});

test("Story containers serialize creator IDs as positioned user tags", () => {
  assert.match(runner, /getInstagramProfileIdentity\(creator\.username\)/);
  assert.match(
    runner,
    /mediaType: "STORIES"[\s\S]*userTags: \[storyMention\(creator\.username, creatorState\.instagramUserId\)\]/,
  );
  assert.match(runner, /user_tags: JSON\.stringify\(input\.userTags\)/);
  assert.match(runner, /user_id: instagramUserId/);
  assert.match(runner, /x: 0\.5/);
  assert.match(runner, /y: 0\.13/);
});

test("Story video has no baked-in mention banner", () => {
  assert.doesNotMatch(runner, /TODAY'S FACEREEL/);
  assert.doesNotMatch(runner, /story-overlay\.png/);
  assert.match(runner, /copyFile\(reelPath, storyPath\)/);
});
