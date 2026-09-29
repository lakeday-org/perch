module.exports.validateInput = (line, { maxSymbols }) => {
  return line.length <= maxSymbols;
};
