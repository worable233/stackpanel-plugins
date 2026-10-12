import { describe, expect, it } from 'vitest';
import {
  collectSelections,
  envelope,
  errorEnvelope,
  field,
  intField,
  minorToMajor,
  parseForm,
  provisionAction,
  toZjmfHost,
  toZjmfProduct,
} from './protocol.js';

describe('zjmf-compat protocol helpers', () => {
  it('parses repeated and bracketed form fields', () => {
    const form = parseForm('pid=42&qty=2&configoption%5B1%5D=a&configoption%5B2%5D=b&tag=x&tag=y');
    expect(field(form, 'pid')).toBe('42');
    expect(field(form, 'qty')).toBe('2');
    expect(form['tag']).toEqual(['x', 'y']);
    expect(collectSelections(form)).toEqual({ '1': 'a', '2': 'b' });
  });

  it('reads integer fields with a positive fallback', () => {
    expect(intField({ qty: '3' }, 'qty')).toBe(3);
    expect(intField({ qty: '0' }, 'qty')).toBe(1);
    expect(intField({ qty: 'abc' }, 'qty')).toBe(1);
    expect(intField({}, 'qty')).toBe(1);
  });

  it('formats money in major units, aware of zero-decimal currencies', () => {
    expect(minorToMajor(1200, 'CNY')).toBe('12.00');
    expect(minorToMajor(1500, 'JPY')).toBe('1500');
  });

  it('projects a platform product into the ZJMF product shape', () => {
    const product = toZjmfProduct({
      id: 'p1',
      name: '云服务器',
      description: '2C4G',
      price: 4900,
      currency: 'CNY',
      stock: 7,
      status: 'ACTIVE',
    });
    expect(product).toMatchObject({
      id: 'p1',
      name: '云服务器',
      description: '2C4G',
      price: '49.00',
      sale_price: '49.00',
      currency_code: 'CNY',
      qty: 7,
    });
  });

  it('projects a service into the 魔方 host shape', () => {
    expect(
      toZjmfHost({ id: 's1', productId: 'p1', productName: '云服务器', status: 'SUSPENDED' }),
    ).toMatchObject({ id: 's1', domain: '云服务器', domainstatus: 'SUSPENDED' });
  });

  it('maps provision funcs onto platform lifecycle actions', () => {
    expect(provisionAction('suspend')).toBe('suspend');
    expect(provisionAction('unsuspend')).toBe('resume');
    expect(provisionAction('resume')).toBe('resume');
    expect(provisionAction('terminate')).toBe('terminate');
    expect(provisionAction('delete')).toBe('terminate');
    expect(provisionAction('reboot')).toBeNull();
  });

  it('builds the {status,msg,data} envelope', () => {
    expect(JSON.parse(envelope(200, { data: { ok: true } }))).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(JSON.parse(errorEnvelope(401, '未登录'))).toEqual({ status: 401, msg: '未登录' });
  });
});
