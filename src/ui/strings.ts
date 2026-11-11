/** All player-facing text in one place, ready for localization. */
export const S = {
  title: 'Glimmerfall',
  tagline: 'Собирай сияние',
  play: 'Играть',
  continue: 'Продолжить',
  level: (n: number): string => `Уровень ${n}`,
  start: 'Старт',
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
  assist: 'Мы немного помогли: на поле стало проще.',
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
