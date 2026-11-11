/** All player-facing text in one place, ready for localization. */
export const S = {
  title: 'Glimmerfall',
  tagline: 'Собирай сияние',
  play: 'Играть',
  continue: 'Продолжить',
  level: (n: number): string => `Уровень ${n}`,
  moves: 'Ходы',
  goals: 'Цели',
  movesCount: (n: number): string => `${n} ${plural(n, 'ход', 'хода', 'ходов')}`,
  hard: 'Сложный уровень',
  relief: 'Передышка',
  intro: {
    ice: { title: 'Новое: лёд', text: 'Делай комбинации на льду, чтобы растопить его.' },
    crate: { title: 'Новое: ящики', text: 'Ящики ломаются от комбинаций рядом и от взрывов.' },
    chain: { title: 'Новое: цепи', text: 'Скованную фишку нельзя двигать. Включи её в комбинацию, чтобы снять цепь.' },
    'double-goal': { title: 'Две цели', text: 'Чтобы пройти уровень, выполни обе цели.' },
  },
  assist: 'Поле попроще',
  gotIt: 'Понятно',
  goalDone: 'Готово!',
  goalHelp: {
    collect: (n: number): string => `Убери ещё ${n} ${plural(n, 'такую фишку', 'такие фишки', 'таких фишек')}: собирай их в ряды по 3 и больше.`,
    ice: (n: number): string => `Растопи лёд ещё на ${n} ${plural(n, 'клетке', 'клетках', 'клетках')}: убирай фишки, которые стоят на льду.`,
    crate: (n: number): string => `Разбей ещё ${n} ${plural(n, 'ящик', 'ящика', 'ящиков')}: собирай ряды рядом с ними или взрывай их.`,
    score: (n: number): string =>
      `Набери ещё ${n.toLocaleString('ru-RU')} ${plural(n, 'очко', 'очка', 'очков')}. Больше всего дают длинные ряды, цепочки и спецфишки.`,
  },
  blockerHelp: {
    ice: 'Лёд тает, когда убираешь фишку над ним.',
    crate: 'Ящик ломается, когда рядом собран ряд или его задел взрыв.',
    chain: 'Фишку в цепях нельзя двигать. Собери с ней ряд, и цепь спадёт.',
  },
  version: (v: string): string => `версия ${v}`,
  paused: 'Пауза',
  resume: 'Продолжить',
  restart: 'Заново',
  menu: 'В меню',
  settings: 'Настройки',
  sound: 'Звук',
  haptics: 'Вибрация',
  reducedMotion: 'Меньше движения',
  reset: 'Сбросить прогресс',
  resetConfirm: 'Точно сбросить?',
  back: 'Назад',
  win: 'Уровень пройден!',
  score: 'Очки',
  next: 'Дальше',
  lose: 'Ходы закончились',
  almost: 'Осталось совсем немного:',
  extraMoves: (n: number): string => `+${n} ходов`,
  retry: 'Ещё раз',
  tapToSkip: 'Нажми, чтобы ускорить',
  praise: ['Отлично!', 'Здорово!', 'Блестяще!', 'Невероятно!', 'Феерично!'],
  shuffle: 'Перемешиваем!',
  on: 'Вкл',
  off: 'Выкл',
} as const;

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
