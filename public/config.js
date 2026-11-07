// Налаштування сайту. Зміни під свій сервер і закоміть, сайт оновиться сам.
export const CONFIG = {
  // Назва в шапці та у вкладці браузера.
  cityName: 'Місто',

  // Вебмапа сервера (BlueMap). У кожного схематика буде кнопка «BlueMap».
  // Порожній url вимикає кнопку. maps: id мапи BlueMap для кожного виміру.
  bluemap: {
    url: 'https://map.cinnamon-mc.fun',
    maps: { overworld: 'world' },
  },
};
