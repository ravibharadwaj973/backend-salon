/**
 * PRINT THE REVIEW A CUSTOMER WOULD BE OFFERED, WITHOUT THE CUSTOMER.
 *
 *   npm run ai:try
 *   npm run ai:try -- --services "Hair Colour - Root Touch Up=4,Gold Facial=5" --wait 2
 *
 * Judging the voice of these drafts by walking the feedback form every time is
 * unworkable: it needs a visit, a link and a submit, and it gives you one
 * sample. This gives you five in a few seconds, from the same prompt the app
 * uses, so "does this sound like a person" is a question you can actually
 * answer.
 *
 * Five and not one, deliberately. The drafts are generated warm so that two
 * customers who rated the same thing do not get the same sentence — a Google
 * page of reviews that all open the same way reads as bought. Five in a column
 * is how you check that is still true after a model or prompt change.
 *
 * Nothing is written to the database. It only calls the model.
 */
import { aiReady, env } from '../src/config/env';
import { draftReviewNow } from '../src/modules/feedback/feedback-ai.service';
import { advertWordsIn } from '../src/modules/feedback/feedback-ai';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function score(name: string): number | null {
  const raw = arg(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

/** "Haircut=4,Gold Facial=5" → [{ name: 'Haircut', rating: 4 }, …] */
function services(): { name: string; rating: number | null }[] {
  const raw = arg('services') ?? 'Hair Colour - Root Touch Up=4,Gold Facial=5';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, value] = part.split('=');
      const rating = Number(value);
      return {
        name: (name ?? '').trim(),
        rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
      };
    });
}

const HOW_MANY = 5;

async function main(): Promise<void> {
  if (!aiReady) {
    console.error(
      'No Groq key. Set GROQ_API_KEY (or GROQ_API) in backend/.env — see .env.example.',
    );
    process.exit(1);
  }

  const input = {
    overallRating: score('rating') ?? 4,
    staffRating: score('staff'),
    waitingRating: score('wait'),
    cleanlinessRating: score('salon'),
    comment: arg('comment') ?? null,
    services: services(),
  };

  console.log(`model: ${env.GROQ_MODEL}`);
  console.log(`input: ${JSON.stringify(input)}\n`);

  for (let attempt = 1; attempt <= HOW_MANY; attempt += 1) {
    const draft = await draftReviewNow(input);
    if (!draft) {
      console.log(`${attempt}. (nothing came back — no key, a timeout, or nothing to draft from)`);
      continue;
    }
    const slipped = advertWordsIn(draft);
    console.log(`${attempt}. ${draft}`);
    // The words that make a review read as bought. Flagged rather than removed,
    // because rewriting a review by regex mangles it — but a column of these
    // means the prompt needs another look.
    if (slipped.length > 0) console.log(`   ⚠ advertisement words: ${slipped.join(', ')}`);
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
