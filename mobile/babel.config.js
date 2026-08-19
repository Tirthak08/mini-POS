module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      // jsxImportSource routes JSX through NativeWind so className works on
      // core React Native components.
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
  };
};
