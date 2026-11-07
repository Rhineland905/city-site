// Настройки сайта. Поменяй под свой сервер и закоммить, сайт обновится сам.
export const CONFIG = {
  // Название в шапке и во вкладке браузера.
  cityName: 'Город',

  // Веб-карта сервера (BlueMap). У каждого схематика будет кнопка «BlueMap».
  // Пустой url отключает кнопку. maps: id карты BlueMap для каждого измерения.
  bluemap: {
    url: 'https://map.cinnamon-mc.fun',
    maps: { overworld: 'world' },
  },
};
