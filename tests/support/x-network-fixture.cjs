"use strict";

function tweet(
  id,
  text,
  {
    parent = null,
    media = false,
    createdAt = "Thu Oct 22 12:00:00 +0000 2026",
  } = {},
) {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: {
      user_results: {
        result: {
          __typename: "User",
          rest_id: "123",
          core: { screen_name: "Owner_Handle" },
        },
      },
    },
    legacy: {
      created_at: createdAt,
      full_text: text,
      in_reply_to_status_id_str: parent,
      conversation_id_str: parent || id,
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
      bookmark_count: 0,
      entities: { urls: [] },
      extended_entities: {
        media: media
          ? [
              {
                type: "video",
                media_key: "7_77",
                video_info: { duration_millis: 1000 },
              },
            ]
          : [],
      },
    },
  };
}
const payload = (...tweets) => ({
  data: { fixture: tweets.map((result) => ({ tweet_results: { result } })) },
});
module.exports = { tweet, payload };
