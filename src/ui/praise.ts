/**
 * Cascade praise: every word has an excitement rating, 1 (quiet approval) to 10 (the peak).
 * Step k of a cascade aims at a rating that climbs fast at first and keeps nearing the peak:
 *   target(k) = 1 + 9 · (1 − e^(−k / RAMP))
 * A word is drawn at random with a Gaussian weight around the target, exp(−(rating − target)² / 2σ²),
 * so neighbouring ratings mix in while far ones stay rare. A shown word sits out and fades back in
 * linearly over COOLDOWN shows, so the same word never comes twice in a row and repeats stay rare.
 */
const WORDS: Record<number, string[]> = {
  1: [
    'Неплохо!', 'Хорошо!', 'Годно!', 'Славно!', 'Есть!', 'Чисто!', 'Ловко!', 'Метко!', 'Точно!', 'Удачно!',
    'Складно!', 'Недурно!', 'Толково!', 'Аккуратно!', 'Так держать!', 'Дельно!', 'Верно!', 'Чётко!', 'Ладно!', 'Неплохой ход!',
  ],
  2: [
    'Отлично!', 'Здорово!', 'Классно!', 'Молодец!', 'Красиво!', 'Прекрасно!', 'Умело!', 'В точку!', 'Красота!', 'Приятно!',
    'Весело!', 'Задорно!', 'Бодро!', 'Живенько!', 'Ай да ход!', 'Прямо в цель!', 'Как по нотам!', 'Всё по плану!',
  ],
  3: [
    'Супер!', 'Круто!', 'Шикарно!', 'Клёво!', 'Браво!', 'Ура!', 'Замечательно!', 'Чудесно!', 'Ого!', 'Ух ты!',
    'Вот это ход!', 'Отменно!', 'Славный ход!', 'Сочно!', 'Ярко!', 'Звонко!', 'Лихо!', 'Здорово вышло!',
  ],
  4: [
    'Великолепно!', 'Блестяще!', 'Превосходно!', 'Мастерски!', 'Эффектно!', 'Мощно!', 'Сильно!', 'Огонь!', 'Высший класс!',
    'Ничего себе!', 'Вот это да!', 'Роскошно!', 'Изящно!', 'Стильно!', 'Смачно!', 'Залихватски!', 'Классика!', 'Солидно!', 'Зашибись!',
  ],
  5: [
    'Бесподобно!', 'Изумительно!', 'Восхитительно!', 'Виртуозно!', 'Ювелирно!', 'Безупречно!', 'Ослепительно!', 'Грандиозно!',
    'Сказочно!', 'Волшебно!', 'Чудеса!', 'Магия!', 'Неудержимо!', 'Каскад!', 'Лавина!', 'Ураган!', 'Высший пилотаж!', 'Шквал!',
  ],
  6: [
    'Невероятно!', 'Потрясающе!', 'Поразительно!', 'Фантастика!', 'Феноменально!', 'Ошеломительно!', 'Сногсшибательно!',
    'Шедевр!', 'Гениально!', 'Буря!', 'Фейерверк!', 'Салют!', 'Цунами!', 'Вихрь!', 'Зрелищно!', 'Головокружительно!',
    'Неподражаемо!', 'Феерия!',
  ],
  7: [
    'Феерично!', 'Эпично!', 'Легендарно!', 'Триумф!', 'Немыслимо!', 'Небывало!', 'Неописуемо!', 'Непостижимо!', 'Запредельно!',
    'Звездопад!', 'Колоссально!', 'Титанически!', 'Умопомрачительно!', 'Землетрясение!', 'Мегакомбо!', 'Нереально!', 'Улёт!',
    'Шедеврально!',
  ],
  8: [
    'Божественно!', 'Космос!', 'Космически!', 'Галактически!', 'Мифически!', 'Сверхновая!', 'Беспрецедентно!',
    'Сверхъестественно!', 'Апофеоз!', 'Большой взрыв!', 'Взрыв мозга!', 'Вне конкуренции!', 'Это рекорд!', 'Безумие!',
    'Сумасшествие!', 'Бомба!', 'Невозможное!', 'Невообразимо!',
  ],
  9: [
    'За гранью!', 'Вне законов физики!', 'Вселенский масштаб!', 'Бесконечность!', 'Это история!', 'Войдёт в легенды!',
    'Неостановимо!', 'Цепная реакция!', 'Термоядерно!', 'Ультракомбо!', 'Гиперкомбо!', 'Чудо света!', 'Рекорд галактики!',
    'Взрыв сверхновой!', 'Абсолют!', 'Чистая магия!', 'Вулкан восторга!', 'Это надо видеть!',
  ],
  10: [
    'Нет слов!', 'Слов не хватает!', 'Боги в восторге!', 'Время остановилось!', 'Абсолютная легенда!', 'Вселенная аплодирует!',
    'Мир не забудет!', 'Звёзды падают!', 'Галактика в шоке!', 'Миф ожил!', 'Небеса рукоплещут!', 'Предела нет!',
    'Бесконечный восторг!', 'Космический рекорд!', 'Это бесконечно!', 'Выше только небо!', 'Легенда легенд!', 'Восьмое чудо!',
  ],
};

const RATED = Object.entries(WORDS).flatMap(([rating, words]) => words.map((word) => ({ word, rating: Number(rating) })));
const PEAK = 10;
/** cascade steps for the target to cover ~63% of the way to the peak */
const RAMP = 5;
/** σ of the Gaussian: a neighbour rating weighs 0.6, two away 0.14, three away 0.01 */
const SPREAD = 1;
/** shows a word sits out before its weight is fully back */
const COOLDOWN = 30;

/** The rating step `step` (0 = first praised step of a cascade) aims at. */
export function targetRating(step: number): number {
  return 1 + (PEAK - 1) * (1 - Math.exp(-step / RAMP));
}

export class PraisePicker {
  private shown = 0;
  private readonly lastShown = new Map<string, number>();

  public constructor(private readonly random: () => number = Math.random) {}

  public next(step: number): string {
    const target = targetRating(step);
    const weights = RATED.map(({ word, rating }) => {
      const last = this.lastShown.get(word);
      const rested = last === undefined ? 1 : Math.min(1, (this.shown - last) / COOLDOWN);
      return Math.exp(-((rating - target) ** 2) / (2 * SPREAD ** 2)) * rested;
    });
    let roll = this.random() * weights.reduce((sum, w) => sum + w, 0);
    let index = 0;
    while (index < weights.length - 1 && (roll -= weights[index]) >= 0) index++;
    const { word } = RATED[index];
    this.lastShown.set(word, this.shown++);
    return word;
  }
}

export const PRAISE_WORDS = RATED;
